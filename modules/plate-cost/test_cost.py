from contextlib import closing
from fractions import Fraction
import json
from pathlib import Path
import random
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from plate_cost import cost_cents, report


class CostTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.db = self.root / "original.db"
        self.prices = self.root / "prices.csv"
        self.prices.write_text(
            "component,unit,from_ms,pack_quantity,pack_price_twd\nraw,g,200,3,4\nraw,g,0,3,2\n",
            encoding="utf8",
        )
        self.book = {
            "components": {
                "raw": {"unit": "g", "pack": 3},
                "broth": {"unit": "ml", "yield": 3, "inputs": {"raw": 2}},
            },
            "dishes": {
                "main": [
                    {"from_ms": 0, "uses": {"broth": 1}},
                    {"from_ms": 100, "uses": {"broth": 2}},
                ]
            },
        }
        with closing(sqlite3.connect(self.db)) as db, db:
            db.executescript("""CREATE TABLE receipts(id INTEGER PRIMARY KEY,created,total,lots);
                                CREATE TABLE entries(receipt,request,result);""")
            db.execute(
                "INSERT INTO receipts VALUES(1,100,3,?)",
                (json.dumps({"main": [{"bundle": None, "qty": 1, "unit": 3}]}),),
            )

    def cost(self, at=None):
        return report(self.db, 1, self.book, self.prices, at)

    def test_effective_dates_and_fractional_intermediates(self):
        self.assertEqual(self.cost()["total"]["ingredient_cost_cents"], 89)
        for at, cents in [(199, 89), (200, 178), (201, 178)]:
            line = self.cost(at)["dishes"][0]
            self.assertEqual(
                (line["recipe_from_ms"], line["ingredient_cost_cents"]), (100, cents)
            )
            self.assertEqual(line["ingredients"][0]["quantity"], "4/3")
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE receipts SET created=99")
        line = self.cost(200)["dishes"][0]
        self.assertEqual(
            (
                line["recipe_from_ms"],
                line["ingredients"][0]["quantity"],
                line["ingredient_cost_cents"],
            ),
            (0, "2/3", 89),
        )

    def test_legacy_return_table_and_negative_remaining_margin(self):
        entry = {
            "receipt": 1,
            "amount": 3,
            "lines": [
                {"dish": "main", "qty": 1, "unit": 3, "bundle": None, "amount": 3}
            ],
        }
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO entries VALUES(1,'r',?)", (json.dumps(entry),))
        self.assertEqual(self.cost()["total"]["after_ingredients_cents"], -89)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("CREATE TABLE voids(receipt,request)")
            db.execute("INSERT INTO voids VALUES(1,'r')")
        self.assertEqual(self.cost()["total"]["after_ingredients_cents"], 211)

    def test_invalid_lots_and_prices_do_not_produce_report(self):
        header = self.prices.read_text(encoding="utf8").splitlines()[0]
        for rows in [
            ["raw,g,101,3,2"],
            ["raw,ml,0,3,2"],
            ["raw,g,0,3,2"] * 2,
            ["raw,g,0,0,2"],
        ]:
            self.prices.write_text("\n".join([header, *rows]), encoding="utf8")
            with self.assertRaises(ValueError):
                self.cost()
        self.prices.write_text(header + "\nraw,g,0,3,2\n", encoding="utf8")
        self.book["components"]["broth"]["inputs"] = {"broth": 1}
        with self.assertRaises(ValueError):
            self.cost()
        self.book["components"]["broth"]["inputs"] = {"raw": 2}
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE receipts SET total=999")
        book = self.root / "recipes.json"
        book.write_text(json.dumps(self.book), encoding="utf8")
        args = [
            sys.executable,
            Path(__file__).with_name("plate_cost.py"),
            self.db,
            "1",
            "--recipes",
            book,
            "--prices",
            self.prices,
        ]
        result = subprocess.run(args, capture_output=True)
        self.assertEqual((result.returncode, result.stdout), (2, b""))
        missing = self.root / "missing.db"
        args[2] = missing
        self.assertEqual(subprocess.run(args, capture_output=True).returncode, 2)
        self.assertFalse(missing.exists())

    def test_reject_refund_that_uses_a_different_price_lot(self):
        entry = {
            "receipt": 1,
            "amount": 3,
            "lines": [
                {"dish": "main", "qty": 1, "unit": 3, "bundle": "other", "amount": 3}
            ],
        }
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("INSERT INTO entries VALUES(1,'r',?)", (json.dumps(entry),))
        with self.assertRaisesRegex(ValueError, "price lots"):
            self.cost()

    def test_cent_allocation_conserves_receipt_total_and_has_stable_ties(self):
        self.assertEqual(
            cost_cents({"b": Fraction(1, 200), "a": Fraction(1, 200)}), {"a": 1, "b": 0}
        )
        rng = random.Random(345)
        for _ in range(500):
            exact = {
                str(i): Fraction(rng.randrange(2000), rng.randrange(1, 89))
                for i in range(rng.randrange(1, 12))
            }
            rounded = cost_cents(exact)
            n, d = (100 * sum(exact.values())).as_integer_ratio()
            self.assertEqual(sum(rounded.values()), (2 * n + d) // (2 * d))
            self.assertEqual(rounded, cost_cents(dict(reversed(exact.items()))))
            self.assertTrue(all(abs(rounded[k] - 100 * exact[k]) < 1 for k in exact))
