"""Exercise both public CLIs against a temporary kitchen ledger."""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parent


def run(script, *args):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return json.loads(subprocess.check_output([sys.executable, script, *args], env=env))


def demo(freight):
    examples = ROOT / "examples"
    recipes = examples / "recipes.json"
    with TemporaryDirectory() as folder:
        temp = Path(folder)
        db = temp / "kitchen.db"
        options = ["--db", db, "--recipes", recipes]
        plan = temp / "plan.json"
        order = temp / "order.json"
        slip = temp / "slip.json"
        procure = [freight / "purchase.py", plan, freight / "examples/suppliers.json"]
        prepare = [ROOT / "prep.py", "--orders", examples / "orders.json", "--recipes", recipes, "--ledger", db]
        receiving = [ROOT / "receiving.py", *options]
        run(ROOT / "ledger.py", "--db", db, "init")
        run(ROOT / "ledger.py", *options, "receive", "opening", examples / "stock.json")
        plan.write_text(json.dumps(run(*prepare)), encoding="utf-8")
        basket = run(*procure)
        order.write_text(json.dumps(basket), encoding="utf-8")
        opened = run(*receiving, "open", "LUNCH", order)
        slip.write_text(json.dumps({"market-soy": 1}), encoding="utf-8")
        first = run(*receiving, "accept", "LUNCH", "market", "AM", slip)
        repeated = run(*receiving, "accept", "LUNCH", "market", "AM", slip)
        partial = run(*receiving, "status", "LUNCH")
        rest = {line["sku"]: line["remaining_packs"] for line in partial["lines"] if line["remaining_packs"]}
        slip.write_text(json.dumps(rest), encoding="utf-8")
        second = run(*receiving, "accept", "LUNCH", "market", "PM", slip)
        closed = run(*receiving, "status", "LUNCH")
        plan.write_text(json.dumps(run(*prepare)), encoding="utf-8")
        after = run(*procure)
        if (opened["remaining_packs"], partial["remaining_packs"], closed["remaining_packs"]) != (7, 6, 0):
            raise ValueError("Expected seven packs, received in two deliveries")
        if first != repeated or first["movements"]["soy"]["delta"] != 25 or closed["state"] != "received":
            raise ValueError("Unexpected receipt or final order status")
        deltas = {k: v["delta"] for k, v in second["movements"].items()}
        deltas["soy"] += first["movements"]["soy"]["delta"]
        if deltas != basket["quantities"] or after["orders"] or after["total_twd"] != 0:
            raise ValueError("Stock ledger did not reconcile with purchased quantities")
        return {"ordered": 7, "first_delivery": 1, "second_delivery": 6, "next_total_twd": 0}


if __name__ == "__main__":
    print(json.dumps(demo(Path(sys.argv[1]).resolve())))
