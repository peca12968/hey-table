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

from prep import order_identity, plan, readiness, snapshot
from readiness_demo import demo

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

    def test_readiness_is_fifo_and_a_short_order_cannot_consume_stock(self):
        book = {"components": {
            "rice": {"unit": "g", "yield": 2, "inputs": {"grain": 1}},
            "grain": {"unit": "g", "pack": 10},
            "sauce": {"unit": "ml", "pack": 10},
        }, "dishes": {
            "with-sauce": [{"from_ms": 0, "uses": {"rice": 1, "sauce": 1}}],
            "plain": [{"from_ms": 0, "uses": {"rice": 1}}],
        }}
        all_orders = [{"id": order_id, "status": "pending", "created": at,
                       "items": [{"id": dish, "qty": 1}]}
                      for order_id, at, dish in [(30, 1, "plain"), (21, 0, "plain"),
                                                 (20, 0, "with-sauce"), (22, 0, "plain")]]
        stock = {"grain": 1}
        result = readiness(all_orders, book, stock)
        rows = result["orders"]
        self.assertEqual([(row["order_id"], row["status"]) for row in rows],
                         [(20, "shortage"), (21, "ready"), (22, "ready"), (30, "shortage")])
        self.assertEqual(rows[0]["missing"], [{"component": "sauce", "name": "sauce", "unit": "ml", "quantity": 1}])
        self.assertEqual(rows[0]["prep"], [])
        self.assertEqual(rows[1]["prep"], [{"component": "rice", "name": "rice", "batches": 1}])
        self.assertEqual(rows[2]["prep"], [])
        self.assertEqual(rows[3]["missing"], [{"component": "grain", "name": "grain", "unit": "g", "quantity": 1}])
        self.assertEqual(result["remaining_stock"], {"grain": 0, "rice": 0})
        self.assertEqual(stock, {"grain": 1})

    def test_readiness_preserves_recipe_revisions_and_validates_prior_issue_receipts(self):
        book, stock, orders = map(example, ["recipes", "stock", "orders"])
        issued = {orders[0]["id"]: order_identity(orders[0])}
        result = readiness(orders, book, stock, issued=issued)
        self.assertEqual([line["order_id"] for line in result["orders"]], [2])
        self.assertEqual(result["orders"][0]["portions"], [
            {"dish": "katsudon", "from_ms": 1000, "quantity": 1},
            {"dish": "oyakodon", "from_ms": 0, "quantity": 2},
        ])
        with self.assertRaisesRegex(ValueError, "differs from its issue receipt"):
            readiness([dict(orders[0], created=1000)], book, stock, issued=issued)
        all_pending = readiness(orders, book, stock, include_preparing=True)
        self.assertEqual([line["order_id"] for line in all_pending["orders"]], [1, 2, 3])

    def test_readiness_demo_can_be_regenerated_from_committed_orders(self):
        initial = demo()
        self.assertEqual(initial, example("readiness-demo"))
        before = initial["before"]["orders"]
        after = initial["after"]["orders"]
        self.assertEqual([row["status"] for row in before], ["ready", "shortage"])
        self.assertEqual(before[1]["missing"], [initial["arrival"]])
        self.assertEqual([row["status"] for row in after], ["ready", "ready"])
        self.assertEqual(before[0], after[0])

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
            forecast = subprocess.check_output([*cli, "--readiness"], env={**os.environ, **env})
            self.assertEqual(json.loads(forecast), readiness(orders, example("recipes"), example("stock")))
