"""Run a synthetic Prep Sheet purchase and receive the same delivery twice in a temporary ledger."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parent


def run(script,*args):
    output=subprocess.check_output([sys.executable,script,*args],env={**os.environ,"PYTHONIOENCODING":"utf-8"})
    return json.loads(output)


def demo(prep):
    examples=prep/"examples"
    recipe=examples/"recipes.json"
    sources=["--orders",examples/"orders.json","--recipes",recipe]
    with tempfile.TemporaryDirectory() as folder:
        temp=Path(folder)
        db=temp/"kitchen.db"
        plan=temp/"plan.json"
        delivery=temp/"delivery.json"
        ledger=["--db",db,"--recipes",recipe]
        run(prep/"ledger.py","--db",db,"init")
        run(prep/"ledger.py",*ledger,"receive","opening-stock",examples/"stock.json")
        before=run(prep/"prep.py",*sources,"--ledger",db)
        if before!=json.loads((ROOT/"examples/lunch.json").read_text(encoding="utf8")):
            raise ValueError("unexpected upstream lunch fixture")
        plan.write_text(json.dumps(before),encoding="utf8")
        report=run(ROOT/"purchase.py",plan,ROOT/"examples/suppliers.json")
        quantities=run(ROOT/"purchase.py",plan,ROOT/"examples/suppliers.json","--format","quantities")
        delivery.write_text(json.dumps(quantities),encoding="utf8")
        first=run(prep/"ledger.py",*ledger,"receive","market-delivery",delivery)
        again=run(prep/"ledger.py",*ledger,"receive","market-delivery",delivery)
        after=run(prep/"prep.py",*sources,"--ledger",db)
        plan.write_text(json.dumps(after),encoding="utf8")
        next_report=run(ROOT/"purchase.py",plan,ROOT/"examples/suppliers.json")
        if first!=again or report["total_twd"]!=165 or next_report["status"]!="ok" or next_report["orders"]:
            raise ValueError("delivery did not reconcile to an empty next basket")
        if {k:v["delta"] for k,v in first["movements"].items()}!=quantities:
            raise ValueError("posted ledger quantities differ from purchased packs")
        return {"included_orders":before["included_orders"],"total_twd":report["total_twd"],
                "packs":report["packs"],"delivery_receipt":first["receipt"],"next_total_twd":next_report["total_twd"]}


if __name__=="__main__":
    print(json.dumps(demo(Path(sys.argv[1]).resolve())))
