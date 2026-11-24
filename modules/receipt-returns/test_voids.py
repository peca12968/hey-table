from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from returns import connect, history, quote, register, statement, void


SAMPLE = json.loads((Path(__file__).parent/"examples/ticket.json").read_bytes())


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name)/"returns.db"
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        register(self.db, SAMPLE)
        self.first = quote(self.db, 1, {"gyoza": 1}, request="one", expected=85)
        self.second = quote(self.db, 1, {"gyoza": 1}, request="two", expected=72)

    def test_earlier_void_restores_exact_lot_even_after_restart_and_replay(self):
        correction = void(self.db, 1, "one", "wrong portion")
        self.assertEqual((correction["restoredAmount"], correction["remainingValueAfterVoid"]), (85, 273))
        with closing(connect(self.path)) as other:
            replay = quote(other, 1, {"gyoza": 1}, request="one", expected=85)
            self.assertEqual(replay, self.first)
            self.assertEqual(history(other, 1), [self.first, self.second])
            preview = quote(other, 1, {"gyoza": 1})
            self.assertEqual((preview["amount"], preview["lines"][0]["bundle"]), (85, None))
            quote(other, 1, {"gyoza": 1}, request="three", expected=85)
            self.assertEqual(void(other, 1, "one", "wrong portion"), correction)
            with self.assertRaises(ValueError):
                void(other, 1, "one", "different reason")
            report = statement(other, 1)
            self.assertEqual((report["recordedAmount"], report["remainingValue"]), (157, 188))
            self.assertEqual([r["status"] for r in report["entries"]], ["voided", "active", "active"])
            self.assertEqual(report["entries"][0]["void"], correction)
            self.assertEqual(report["entries"][1]["entry"], self.second)
            with self.assertRaises(ValueError):
                quote(other, 1, {"gyoza": 1})

    def test_concurrent_void_replays_and_only_one_new_return_can_use_freed_portion(self):
        def parallel(operation):
            gate = Barrier(6)
            def run(i):
                with closing(connect(self.path)) as db:
                    gate.wait(timeout=10)
                    try:
                        return operation(db, i)
                    except ValueError:
                        return None
            with ThreadPoolExecutor(6) as workers:
                return list(workers.map(run, range(6)))
        saved = parallel(lambda db, _: void(db, 1, "one", "duplicate registration"))
        self.assertIsNotNone(saved[0])
        self.assertTrue(all(r == saved[0] for r in saved))
        results = parallel(lambda db, i: quote(db, 1, {"gyoza": 1}, request=f"new-{i}", expected=85))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(statement(self.db, 1)["recordedAmount"], 157)

    def test_multi_dish_correction_zero_price_and_receipt_scoping(self):
        register(self.db, {"id": 2, "created": 1, "total": 25, "items": [
            {"id":"tea","qty":2,"price":0}, {"id":"snack","qty":1,"price":25}]})
        quote(self.db, 2, {"tea":1, "snack":1}, request="one", expected=25)
        quote(self.db, 2, {"tea":1}, request="free", expected=0)
        void(self.db, 2, "one", "wrong items")
        void(self.db, 2, "free", "free portion corrected")
        self.assertEqual(quote(self.db, 2, {"tea":2, "snack":1})["amount"], 25)
        self.assertEqual(statement(self.db, 1)["remainingValue"], 188)
        for rid, request, reason in [(1,"free","absent"), (2,"one"," "), (5,"one","missing")]:
            with self.assertRaises(ValueError):
                void(self.db, rid, request, reason)

    def test_old_database_opens_and_failed_void_leaves_original_lots_used(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE voids")  # Reproduce the original two-table schema with live entries.
        with closing(connect(self.path)) as upgraded:
            self.assertEqual(statement(upgraded, 1)["recordedAmount"], 157)
            upgraded.execute("""CREATE TRIGGER fail_void BEFORE INSERT ON voids
                                BEGIN SELECT RAISE(ABORT, 'simulated failure'); END""")
            with self.assertRaises(sqlite3.IntegrityError):
                void(upgraded, 1, "two", "wrong bundle")
            self.assertEqual(statement(upgraded, 1)["recordedAmount"], 157)
            upgraded.execute("DROP TRIGGER fail_void")
            void(upgraded, 1, "two", "wrong bundle")
            self.assertEqual(quote(upgraded, 1, {"gyoza":1})["amount"], 72)
