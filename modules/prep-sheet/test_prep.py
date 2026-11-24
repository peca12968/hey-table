from contextlib import closing
from copy import deepcopy
from itertools import product
import json
from pathlib import Path
from random import Random
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from prep import plan, snapshot

ROOT = Path(__file__).resolve().parent


def example(name):
    return json.loads((ROOT / "examples" / (name + ".json")).read_text("utf8"))


class PrepTests(unittest.TestCase):
    def test_versions_selection_stock_and_shared_dependency(self):
        book, stock, orders = map(example, ["recipes", "stock", "orders"])
        result = plan(orders, book, stock)
        self.assertEqual(result["included_orders"], [1, 2])
        self.assertEqual([p["quantity"] for p in result["portions"]], [2, 1, 2])
        lines = {r["component"]: r for r in result["lines"]}
        for name, (needed, batches, remaining) in {
            "rice": (920, 2, 100), "sauce": (150, 2, 40), "dashi": (170, 1, 0),
            "water": (620, 0, 1380), "cutlet": (3, 1, 2)}.items():
            self.assertEqual([lines[name][k] for k in ("needed", "batches", "remaining")],
                             [needed, batches, remaining])
        self.assertEqual(plan(orders, book, stock, True)["included_orders"], [1, 2, 3])
        self.assertEqual(plan([orders[-1]], book, stock)["lines"], [])
        self.assertEqual(result, plan(reversed(orders), book, stock))

    def test_whole_batches_match_exhaustive_feasible_production(self):
        rng = Random(913)
        for _ in range(120):
            size_a, size_b, pack = [rng.randint(2, 5) for _ in range(3)]
            demand_a, demand_b, direct = [rng.randint(1, 5) for _ in range(3)]
            stock = {key: rng.randint(0, 5) for key in "abr"}
            book = {"components": {
                "r": {"unit": "g", "pack": pack},
                "b": {"unit": "ml", "yield": size_b, "inputs": {"r": 2}},
                "a": {"unit": "ml", "yield": size_a, "inputs": {"b": 2, "r": 1}}},
                "dishes": {"meal": [{"from_ms": 0, "uses": {"a": demand_a, "b": demand_b, "r": direct}}]}}
            orders = [{"id": 1, "created": 1, "status": "pending", "items": [{"id": "meal", "qty": 1}]}]
            lines = {r["component"]: r["batches"] for r in plan(orders, book, stock)["lines"]}
            feasible = [(a,b,r) for a,b,r in product(range(4),range(7),range(12))
                        if stock["a"] + a*size_a >= demand_a and stock["b"] + b*size_b >= demand_b + 2*a
                        and stock["r"] + r*pack >= direct + a + 2*b]
            self.assertEqual(tuple(lines[k] for k in "abr"), tuple(min(row[i] for row in feasible) for i in range(3)))

    def test_invalid_data_fails_instead_of_undercounting(self):
        book, stock, orders = map(example, ["recipes", "stock", "orders"])
        for bad_orders in [[orders[0], orders[0]], [dict(orders[0], status="held")],
                           [dict(orders[0], items=[{"id": "noodles", "qty": 2}])],
                           [dict(orders[0], items=[{"id": "gyoza", "qty": True}])]]:
            with self.assertRaises(ValueError):
                plan(bad_orders, book, stock)
        for change in ("cycle", "missing", "zero", "revision"):
            damaged = deepcopy(book)
            if change == "cycle": damaged["components"]["rice"]["inputs"]["rice"] = 1
            if change == "missing": damaged["components"]["rice"]["inputs"]["absent"] = 1
            if change == "zero": damaged["components"]["rice"]["yield"] = 0
            if change == "revision": damaged["dishes"]["katsudon"].reverse()
            with self.assertRaises(ValueError):
                plan(orders, damaged, stock)
        with self.assertRaises(ValueError):
            plan(orders, book, {"rice": -1})

    def test_sqlite_snapshot_and_cli_match_kitchen_json(self):
        orders = example("orders")
        with TemporaryDirectory() as temp:
            path = Path(temp) / "order # 7.db"
            with closing(sqlite3.connect(path)) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE orders(id INTEGER PRIMARY KEY,created INTEGER,status TEXT,items TEXT)")
                db.executemany("INSERT INTO orders VALUES (?,?,?,?)", [(o["id"],o["created"],o["status"],
                               json.dumps(o["items"])) for o in orders])
                db.commit()
                cursor = snapshot(path)
                self.assertEqual(next(cursor)["id"], 1)
                db.execute("UPDATE orders SET status='ready' WHERE id=2")
                db.commit()
                self.assertEqual(next(cursor)["status"], "pending")
                cursor.close()
            cli = [sys.executable, ROOT / "prep.py", "--database", path, "--recipes", ROOT / "examples/recipes.json",
                   "--stock", ROOT / "examples/stock.json"]
            orders[1]["status"] = "ready"
            env = {"PYTHONUTF8": "1"}
            import os
            result = subprocess.check_output(cli, env={**os.environ, **env})
            self.assertEqual(json.loads(result), plan(orders, example("recipes"), example("stock")))
