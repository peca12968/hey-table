"""Replay a combo sale, a return, a correction and a supplier price change."""

import argparse
from collections import Counter
from fractions import Fraction
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parent


def run(script, *args):
    command = [sys.executable, str(script), *map(str, args)]
    return json.loads(
        subprocess.check_output(
            command, encoding="utf8", env={**os.environ, "PYTHONIOENCODING": "utf-8"}
        )
    )


def demo(prep, returns):
    recipes = prep / "examples/recipes.json"
    ticket_file = returns / "examples/ticket.json"
    ticket = json.loads(ticket_file.read_bytes())
    with TemporaryDirectory() as directory:
        temp = Path(directory)
        db = temp / "kitchen.db"

        def register(*args):
            return run(returns / "returns.py", db, *args)

        def costing(*args):
            return run(
                ROOT / "plate_cost.py",
                db,
                1,
                "--recipes",
                recipes,
                "--prices",
                ROOT / "examples/prices.csv",
                *args,
            )

        register("import", ticket_file)
        sold = costing()
        assert sold["total"] == {
            "receipt_twd": 345,
            "return_credit_twd": 0,
            "net_twd": 345,
            "ingredient_cost_cents": 9687,
            "after_ingredients_cents": 24813,
        }
        assert {d["dish"]: d["receipt_twd"] for d in sold["dishes"]} == {
            "oyakodon": 143,
            "gyoza": 157,
            "sencha": 45,
        }
        # At this scale every intermediate prep yield divides the required amount.
        # The independent whole-batch planner should need exactly the scaled raw inputs.
        scale = 1920
        scaled = dict(
            ticket,
            items=[dict(line, qty=line["qty"] * scale) for line in ticket["items"]],
        )
        order_file, stock_file = temp / "orders.json", temp / "stock.json"
        order_file.write_text(json.dumps([scaled]), encoding="utf8")
        stock_file.write_text("{}", encoding="utf8")
        plan = run(
            prep / "prep.py",
            "--orders",
            order_file,
            "--recipes",
            recipes,
            "--stock",
            stock_file,
        )
        expected = {
            row["component"]: row["needed"]
            for row in plan["lines"]
            if row["action"] == "purchase"
        }
        used = Counter()
        for dish in sold["dishes"]:
            for raw in dish["ingredients"]:
                used[raw["component"]] += Fraction(raw["quantity"]) * scale
        assert used == expected
        register("record", 1, "gyoza=1", "--request", "side", "--expected", 85)
        credited = costing()
        assert credited["total"]["after_ingredients_cents"] == 16313
        assert credited["total"]["ingredient_cost_cents"] == 9687
        assert (
            credited["total"]["net_twd"]
            == register("statement", 1)["remainingValue"]
            == 260
        )
        register("void", 1, "--request", "side", "--reason", "fixture correction")
        assert costing() == sold
        repriced = costing("--price-at-ms", 1796000000000)
        assert repriced["total"]["ingredient_cost_cents"] == 10887
        assert repriced["total"]["after_ingredients_cents"] == 23613
        return {
            "original": sold["total"],
            "after_return": credited["total"],
            "at_new_pack_price": repriced["total"],
            "checked_raw_ingredients": len(expected),
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prep_sheet", type=Path)
    parser.add_argument("receipt_returns", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            demo(args.prep_sheet.resolve(), args.receipt_returns.resolve()), indent=2
        )
    )
