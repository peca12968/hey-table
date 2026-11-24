from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier, Event
import unittest
from unittest.mock import patch

from ledger import connect, initialize, inventory_snapshot, post, read_inventory, read_json
from receiving import accept, cancel, open_order, procurement_snapshot, status


def vendor(name, *lines):
    return {"supplier": name, "lines": [{"sku": sku, "component": "soy", "unit": "ml",
                                         "pack": size, "packs": count} for sku, size, count in lines]}


class ReceivingTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "kitchen.db"
        initialize(self.path)
        self.book = read_json(Path(__file__).parent / "examples/recipes.json")
        self.order = {"status": "ok", "orders": [vendor("market", ("S", 25, 2), ("L", 50, 1)),
                                                vendor("depot", ("S", 10, 1))]}

    def open(self, order_id="p", report=None):
        return open_order(self.path, self.book, order_id, self.order if report is None else report)

    def receive(self, packs, slip="1", supplier="market", order_id="p"):
        return accept(self.path, self.book, order_id, supplier, slip, packs)

    def status(self):
        with closing(connect(self.path, "ro")) as db:
            return status(db, "p")

    def stock(self):
        return inventory_snapshot(self.path, self.book)[0]

    def test_existing_ledger_split_deliveries_and_scoped_replay(self):
        old = post(self.path, self.book, "receive", "1", {"soy": 3})
        with self.assertRaisesRegex(ValueError, "Unknown purchase order"):
            self.status()
        self.assertEqual(self.open()["state"], "open")
        first = self.receive({"L": 1, "S": 1})
        self.assertEqual(first["movements"]["soy"]["balance"], 78)
        reordered = deepcopy(self.order)
        reordered["orders"].reverse()
        reordered["orders"][1]["lines"].reverse()
        partial = self.open(report=reordered)
        self.assertEqual((partial["state"], partial["remaining_packs"]), ("partial", 2))
        self.receive({"S": 1}, supplier="depot")
        self.receive({"S": 1}, slip="2")
        self.assertEqual(self.status()["state"], "received")
        self.assertEqual(self.receive({"S": 1, "L": 1}), first)
        self.open("q")
        self.receive({"S": 1}, order_id="q")
        self.assertEqual(self.stock(), {"soy": 138})
        self.assertEqual(post(self.path, self.book, "receive", "1", {"soy": 3}), old)
        with self.assertRaisesRegex(ValueError, "reference already used"):
            self.receive({"S": 1})

    def test_rollback_invalid_lines_and_retry_same_slip(self):
        original = self.open()
        for invalid in [{"S": 2, "L": 2}, {"S": 1, "unknown": 1}, {}, {"S": True}, {"S": 0}, {"L": -1}]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.receive(invalid)
            self.assertEqual(self.status(), original)
            self.assertEqual(self.stock(), {})
        changed = deepcopy(self.order)
        changed["orders"][0]["lines"][0]["pack"] = 29
        with self.assertRaisesRegex(ValueError, "different lines"):
            self.open(report=changed)
        self.receive({"S": 1})
        self.assertEqual(self.stock(), {"soy": 25})

    def test_bad_import_and_unit_or_balance_change_rolls_back(self):
        for report in [{"status": "infeasible"}, {"status": "ok", "orders": []},
                       {"status": "ok", "orders": [vendor("m", ("S", 10, 1), ("S", 25, 1))]}]:
            with self.assertRaises(ValueError):
                self.open(report=report)
        original = self.open()
        changed = deepcopy(self.book)
        changed["components"]["soy"]["unit"] = "L"
        with self.assertRaisesRegex(ValueError, "no longer match"):
            accept(self.path, changed, "p", "market", "1", {"S": 1})
        post(self.path, self.book, "receive", "storage", {"soy": 2**63 - 1})
        with self.assertRaisesRegex(ValueError, "integer range"):
            self.receive({"S": 1})
        self.assertEqual(self.status(), original)

    def test_eight_connections_claim_last_pack_once(self):
        self.open()
        start = Barrier(8)

        def claim(index):
            start.wait(timeout=15)
            try:
                return self.receive({"L": 1}, slip=str(index))
            except ValueError as error:
                self.assertIn("outstanding", str(error))
                return None

        with ThreadPoolExecutor(max_workers=8) as workers:
            receipts = [r for r in workers.map(claim, range(8)) if r]
        self.assertEqual(len(receipts), 1)
        self.assertEqual(self.stock(), {"soy": 50})
        self.assertEqual(self.status()["remaining_packs"], 3)

    def test_procurement_uses_one_snapshot_across_a_concurrent_delivery(self):
        self.open()
        with closing(connect(self.path, "rw")) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        stock_read = Event()
        delivery_posted = Event()

        def pause_after_stock(db, book):
            result = read_inventory(db, book)
            stock_read.set()
            self.assertTrue(delivery_posted.wait(timeout=10))
            return result

        with patch("receiving.read_inventory", side_effect=pause_after_stock), ThreadPoolExecutor() as workers:
            before = workers.submit(procurement_snapshot, self.path, self.book, ["p"])
            try:
                self.assertTrue(stock_read.wait(timeout=10))
                self.receive({"S": 1})
            finally:
                delivery_posted.set()
            self.assertEqual(before.result(), ({}, {}, {"soy": 110}))
        self.assertEqual(procurement_snapshot(self.path, self.book, ["p"]), ({"soy": 25}, {}, {"soy": 85}))

    def test_supplier_cancellation_replays_and_frees_only_its_undelivered_packs(self):
        initial = self.open()
        self.assertEqual(initial["cancellations"], [])
        self.receive({"S": 1})
        with self.assertRaisesRegex(ValueError, "only 1 packs outstanding"):
            cancel(self.path, "p", "market", "change-1", {"L": 1, "S": 2})
        self.assertEqual(self.status()["cancellations"], [])
        cancelled = cancel(self.path, "p", "market", "change-1", {"L": 1, "S": 1})
        self.assertEqual(cancel(self.path, "p", "market", "change-1", {"S": 1, "L": 1}), cancelled)
        with self.assertRaisesRegex(ValueError, "reference already used"):
            cancel(self.path, "p", "market", "change-1", {"S": 1})
        self.assertEqual(procurement_snapshot(self.path, self.book, ["p"]), ({"soy": 25}, {}, {"soy": 10}))
        with self.assertRaisesRegex(ValueError, "only 0 packs outstanding"):
            self.receive({"S": 1}, slip="late")
        self.assertEqual(self.receive({"S": 1})["receipt"], 1)
        cancel(self.path, "p", "depot", "change-1", {"S": 1})
        final = self.status()
        self.assertEqual((final["state"], final["remaining_packs"]), ("closed", 0))
        self.assertEqual([row["cancelled_packs"] for row in final["lines"]], [1, 1, 1])
        self.assertEqual(self.stock(), {"soy": 25})
        with closing(connect(self.path, "ro")) as db:
            self.assertEqual(db.execute("SELECT kind FROM receipts").fetchall(), [("purchase_receive",)])

    def test_cancel_and_receive_cannot_both_use_last_outstanding_pack(self):
        self.open(report={"status": "ok", "orders": [vendor("market", ("L", 50, 1))]})
        start = Barrier(2)

        def attempt(operation, *args):
            start.wait(timeout=10)
            try:
                return operation(*args) is not None
            except ValueError as error:
                self.assertIn("only 0 packs outstanding", str(error))
                return False

        with ThreadPoolExecutor(max_workers=2) as workers:
            delivered = workers.submit(attempt, self.receive, {"L": 1})
            cancelled = workers.submit(attempt, cancel, self.path, "p", "market", "supplier-change", {"L": 1})
            self.assertNotEqual(delivered.result(), cancelled.result())
        final = self.status()
        self.assertEqual((final["state"], final["remaining_packs"]),
                         ("received" if delivered.result() else "cancelled", 0))
        self.assertEqual(self.stock(), {"soy": 50} if delivered.result() else {})
