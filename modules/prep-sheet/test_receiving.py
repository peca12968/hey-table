from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from ledger import connect, initialize, inventory_snapshot, post, read_json
from receiving import accept, open_order, status


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
