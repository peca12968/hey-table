from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from ledger import connect, initialize, inventory_snapshot, post
from prep import plan


class KitchenLedgerTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "kitchen #3.db"
        initialize(self.path)
        self.book = json.loads((Path(__file__).parent / "examples/recipes.json").read_text("utf-8"))

    def post(self, kind, ref, payload):
        return post(self.path, self.book, kind, ref, payload)

    def state(self):
        return inventory_snapshot(self.path, self.book)

    def order(self, number, qty=1):
        return {"id": number, "status": "pending", "created": 1000, "items": [{"id": "sencha", "qty": qty}]}

    def test_two_staff_and_replayed_commands_share_one_last_portion(self):
        self.post("receive", "morning", {"tea": 4, "water": 220})
        start = Barrier(8)
        def claim(i):
            start.wait(timeout=15)
            try:
                return self.post("issue", str(i), self.order(i))
            except ValueError as error:
                self.assertIn("available", str(error))
                return None
        with ThreadPoolExecutor(max_workers=8) as workers:
            won = [r for r in workers.map(claim, range(1, 9)) if r]
        self.assertEqual(len(won), 1)
        number = int(won[0]["reference"])
        with ThreadPoolExecutor(max_workers=8) as workers:
            retries = list(workers.map(lambda _: self.post("issue", str(number), self.order(number)), range(8)))
        self.assertEqual(retries, won * 8)
        self.assertEqual(self.state(), ({"tea": 0, "water": 0},
                                        {number: {"created": 1000, "items": [["sencha", 1]]}}))
        with closing(connect(self.path, "ro")) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM receipts").fetchone()[0], 2)
        stock, issued = self.state()
        self.assertEqual(plan([self.order(i) for i in range(1, 9)], self.book, stock, issued=issued)
                         ["included_orders"], [i for i in range(1, 9) if i != number])

    def test_rollback_then_retry_and_audit_old_balance(self):
        received = self.post("receive", "a", {"grain": 180, "water": 239})
        with self.assertRaisesRegex(ValueError, "water"):
            self.post("make", "pot1", {"component": "rice", "batches": 1})
        self.assertEqual(self.state()[0], {"grain": 180, "water": 239})
        self.post("receive", "b", {"water": 1})
        made = self.post("make", "pot1", {"component": "rice", "batches": 1})
        self.assertEqual(made["movements"]["rice"], {"unit": "g", "delta": 400, "balance": 400})
        self.assertEqual(self.post("receive", "a", {"water": 239, "grain": 180}), received)
        with self.assertRaisesRegex(ValueError, "reference already used"):
            self.post("make", "pot1", {"component": "rice", "batches": 2})
        with self.assertRaisesRegex(ValueError, "reference already used"):
            self.post("receive", "a", {"water": 240, "grain": 180})
        with self.assertRaises(FileExistsError):
            initialize(self.path)
        self.assertEqual(self.state()[0], {"grain": 0, "water": 0, "rice": 400})

    def test_units_order_identity_and_closed_orders(self):
        self.post("receive", "a", {"tea": 8, "water": 440})
        order = self.order(12)
        for status in ("ready", "completed", "cancelled"):
            with self.assertRaisesRegex(ValueError, "no longer"):
                self.post("issue", "12", dict(order, status=status))
        self.post("issue", "12", dict(order, status="preparing"))
        stock, issued = self.state()
        with self.assertRaisesRegex(ValueError, "differs"):
            plan([self.order(12, 2)], self.book, stock, issued=issued)
        with self.assertRaisesRegex(ValueError, "reference already used"):
            self.post("issue", "12", self.order(12, 2))
        changed = deepcopy(self.book)
        changed["components"]["water"]["unit"] = "L"
        with self.assertRaisesRegex(ValueError, "units differ"):
            post(self.path, changed, "issue", "13", self.order(13))
        self.assertEqual(self.state(), (stock, issued))
        with self.assertRaisesRegex(ValueError, "units differ"):
            inventory_snapshot(self.path, changed)
