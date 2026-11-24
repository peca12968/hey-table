"""Exercise procurement and receiving against a temporary kitchen ledger."""
from collections import Counter
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
        order = temp / "order.json"
        slip = temp / "slip.json"
        procure = [ROOT / "lunch.py", "--orders", examples / "orders.json", "--recipes", recipes,
                   "--ledger", db, "--suppliers", freight / "examples/suppliers.json"]
        receiving = [ROOT / "receiving.py", *options]
        run(ROOT / "ledger.py", "--db", db, "init")
        run(ROOT / "ledger.py", *options, "receive", "opening", examples / "stock.json")
        basket = run(*procure, "--purchase-only")
        order.write_text(json.dumps(basket), encoding="utf-8")
        opened = run(*receiving, "open", "LUNCH", order)
        slip.write_text(json.dumps({"market-soy": 1}), encoding="utf-8")
        first = run(*receiving, "accept", "LUNCH", "market", "AM", slip)
        repeated = run(*receiving, "accept", "LUNCH", "market", "AM", slip)
        partial = run(*receiving, "status", "LUNCH")
        physical = run(*procure)
        covered = run(*procure, "--incoming", "LUNCH", "--incoming", "LUNCH")
        slip.write_text(json.dumps({"market-grain": 1}), encoding="utf-8")
        cancel = [ROOT / "receiving.py", "--db", db, "cancel", "LUNCH", "market", "OUT-OF-STOCK", slip]
        cancellation = run(*cancel)
        if run(*cancel) != cancellation:
            raise ValueError("Supplier cancellation did not replay its original receipt")
        replacement = run(*procure, "--incoming", "LUNCH")
        if (replacement["prep"] != covered["prep"] or "grain" in replacement["incoming"] or
                replacement["purchase"]["quantities"] != {"grain": 400}):
            raise ValueError("Expected a replacement for only the cancelled grain pack")
        reduced = run(*receiving, "status", "LUNCH")
        rest = {line["sku"]: line["remaining_packs"] for line in reduced["lines"] if line["remaining_packs"]}
        slip.write_text(json.dumps(rest), encoding="utf-8")
        second = run(*receiving, "accept", "LUNCH", "market", "PM", slip)
        closed = run(*receiving, "status", "LUNCH")
        order.write_text(json.dumps(replacement["purchase"]), encoding="utf-8")
        run(*receiving, "open", "REPLACEMENT", order)
        vendor, = replacement["purchase"]["orders"]
        slip.write_text(json.dumps({line["sku"]: line["packs"] for line in vendor["lines"]}), encoding="utf-8")
        last = run(*receiving, "accept", "REPLACEMENT", vendor["supplier"], "PM", slip)
        after = run(*procure)
        if tuple(item["remaining_packs"] for item in (opened, partial, reduced, closed)) != (7, 6, 5, 0):
            raise ValueError("Expected seven packs, one cancelled after the first delivery")
        if first != repeated or first["movements"]["soy"]["delta"] != 25 or closed["state"] != "closed":
            raise ValueError("Unexpected receipt or final order status")
        late_deliveries = Counter({k: v["delta"] for k, v in second["movements"].items()})
        late_deliveries.update({k: v["delta"] for k, v in last["movements"].items()})
        if (covered["incoming"] != late_deliveries or covered["prep"] != physical["prep"] or
                covered["purchase"]["total_twd"] != 0 or physical["purchase"]["total_twd"] <= 0):
            raise ValueError("Expected only the undelivered packs to offset procurement, not prep")
        deltas = late_deliveries + Counter({"soy": first["movements"]["soy"]["delta"]})
        if deltas != basket["quantities"] or after["purchase"]["orders"] or after["purchase"]["total_twd"] != 0:
            raise ValueError("Stock ledger did not reconcile with purchased quantities")
        return {"ordered": 7, "first_delivery": 1, "cancelled": 1, "second_delivery": 5,
                "replacement_delivery": 1, "next_total_twd": 0}


if __name__ == "__main__":
    print(json.dumps(demo(Path(sys.argv[1]).resolve())))
