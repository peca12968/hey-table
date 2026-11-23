from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from itertools import product
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from pricing import price_lots
from returns import connect, history, quote, register

SAMPLE = json.loads((Path(__file__).parent / "examples/ticket.json").read_text(encoding="utf-8"))
# Independent unit-price oracle, derived from the sample's three menu prices.
UNITS = {"gyoza": [85, 72], "oyakodon": [143], "sencha": [45]}


def sequences(left):
    if not any(left.values()):
        yield []
        return
    for quantities in product(*(range(n + 1) for n in left.values())):
        if any(quantities):
            group = {key: qty for key, qty in zip(left, quantities) if qty}
            for later in sequences({key: n - group.get(key, 0) for key, n in left.items()}):
                yield [group, *later]


class ReturnsTest(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "returns.db"
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        register(self.db, SAMPLE)

    def test_all_ordered_groupings_exhaust_exactly_the_frozen_total(self):
        paths = list(sequences({dish: len(units) for dish, units in UNITS.items()}))
        self.assertEqual(len(paths), 44)
        for rid, path in enumerate(paths, 2):
            register(self.db, {**SAMPLE, "id": rid})
            used = Counter()
            balance = 345
            for i, selection in enumerate(path):
                expected = sum(sum(UNITS[d][used[d]:used[d] + qty]) for d, qty in selection.items())
                result = quote(self.db, rid, selection, request=str(i), expected=expected)
                used.update(selection)
                balance -= expected
                self.assertEqual((result["amount"], result["remainingValue"]), (expected, balance))
            self.assertEqual(balance, 0)
            with self.assertRaises(ValueError):
                quote(self.db, rid, {"gyoza": 1})

    def test_preview_replay_rollback_and_stale_price(self):
        first = quote(self.db, 1, {"gyoza": 1})
        self.assertEqual((first["amount"], history(self.db, 1)), (85, []))
        saved = quote(self.db, 1, {"gyoza": 1}, request="one", expected=85)
        self.assertEqual(quote(self.db, 1, {"gyoza": 1})["amount"], 72)
        for selection, key, price in [({"gyoza": 1}, "two", 85), ({"sencha": 1}, "one", 45),
                                      ({"gyoza": 1}, "one", 72), ({"gyoza": 1, "unknown": 1}, "bad", 72)]:
            with self.assertRaises(ValueError):
                quote(self.db, 1, selection, request=key, expected=price)
        self.assertEqual(history(self.db, 1), [saved])
        quote(self.db, 1, {"gyoza": 1}, request="two", expected=72)
        other = connect(self.path)
        self.addCleanup(other.close)
        self.assertEqual(quote(other, 1, {"gyoza": 1}, request="one", expected=85), saved)
        self.assertEqual(len(history(other, 1)), 2)

    def test_two_connections_compete_for_same_quantity_or_stale_prices(self):
        def race(dish, keys, price):
            barrier = Barrier(2)
            def worker(key):
                db = connect(self.path)
                try:
                    barrier.wait(timeout=5)
                    return quote(db, 1, {dish: 1}, request=key, expected=price)
                except ValueError as exc:
                    return str(exc)
                finally:
                    db.close()
            with ThreadPoolExecutor(2) as pool:
                return list(pool.map(worker, keys))
        a, b = race("sencha", ("same", "same"), 45)
        self.assertIsInstance(a, dict)
        self.assertEqual(a, b)
        results = race("gyoza", ("first", "other"), 85)
        self.assertEqual(sum(isinstance(v, dict) for v in results), 1)
        self.assertIn("current amount 72", next(v for v in results if isinstance(v, str)))
        results = race("oyakodon", ("x", "y"), 143)
        self.assertEqual(sum(isinstance(v, dict) for v in results), 1)
        self.assertEqual(len(history(self.db, 1)), 3)

    def test_rescanning_and_legacy_price(self):
        register(self.db, {**SAMPLE, "items": list(reversed(SAMPLE["items"])), "status": "completed"})
        for changed in [{"created": 0}, {"combo": None}]:
            with self.assertRaises((TypeError, ValueError)):
                register(self.db, {**SAMPLE, **changed})
        legacy = {"id": 2, "created": 1, "items": [{"id": "gyoza", "price": 83, "qty": 2}], "total": 166}
        register(self.db, legacy)
        self.assertEqual(quote(self.db, 2, {"gyoza": 1})["amount"], 83)
        zero = {"id": 3, "created": 2, "items": [{"id": "tea", "price": 0, "qty": 1}], "total": 0}
        register(self.db, zero)
        quote(self.db, 3, {"tea": 1}, request="gift", expected=0)
        with self.assertRaises(ValueError):
            quote(self.db, 3, {"tea": 1})
        for selection in [{}, {"gyoza": 3}, {"gyoza": True}, {"gyoza": 1.5}, {"unknown": 1}]:
            with self.assertRaises(ValueError):
                quote(self.db, 2, selection)

    def test_reject_inconsistent_quote_before_import(self):
        for path, value in [
            (("combo", "version"), "future"), (("items", 0, "price"), 1),
            (("combo", "quote", "total"), 346), (("combo", "quote", "currency"), "USD"),
            (("combo", "quote", "lines", 0, "discount"), 0),
            (("combo", "quote", "bundles", 0, "sideUnitDiscount"), 15),
            (("combo", "quote", "bundles", 0, "qty"), 3),
        ]:
            copy = deepcopy(SAMPLE)
            parent = copy
            for key in path[:-1]:
                parent = parent[key]
            parent[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(ValueError):
                price_lots(copy)


if __name__ == "__main__":
    unittest.main()
