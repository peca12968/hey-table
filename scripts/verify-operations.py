"""Verify the restaurant back office and its integration with the checkout and warehouse."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
MODULES = ROOT / "modules"
PYTHON = sys.executable


def run(module, *args, variables=None):
    print(f"\n[{module}] " + " ".join(map(str, args)), flush=True)
    subprocess.run(args, cwd=MODULES / module, check=True, env={
        **os.environ, "PYTHON": PYTHON, "PYTHONUTF8": "1", **(variables or {})
    })


def kitchen_and_fulfillment():
    migrations = str(ROOT / "drizzle")
    suites = {
        "batch-clock": {},
        "batch-waste": {},
        "dispatch-window": {},
        "pantry-freight": {},
        "pass-rail": {},
        "pickup-agenda": {},
        "plate-cost": {},
        "prep-sheet": {},
        "ready-range": {},
        "receipt-returns": {"TABLE_SHARES_DIR": str(MODULES / "table-shares")},
        "return-docket": {},
        "table-shares": {"COMBO_PROJECT": str(MODULES / "combo-counter")},
        "wallet-observer": {},
        "payout-ledger": {"HEY_TABLE_MIGRATIONS": migrations, "REMIT_MATCH_DIR": str(MODULES / "remit-match")},
        "remit-match": {"PAYOUT_BANK_CLOSE": str(MODULES / "payout-ledger/bank_close.py")},
    }
    run("return-docket", "dotnet", "build", "-c", "Release")
    for module, variables in suites.items():
        run(module, PYTHON, "-m", "unittest", "-q", variables=variables)
    run("stockroom-reservations", PYTHON, "-m", "pytest", "-q")
    run("menu-pairs", "node", "--test", "pairs.test.mjs", variables={"HEY_TABLE_MIGRATIONS": migrations})
    run("table-shares", "node", "table-demo.mjs", ROOT, MODULES / "combo-counter")
    run("combo-counter", "node", "--test", "quote.test.mjs")
    run("combo-counter", "node", "restaurant-demo.mjs", ROOT)
    run("pickup-window", "node", "--test", "estimate.test.mjs")
    run("pickup-window", "node", "worker-demo.mjs", ROOT)
    run("pickup-agenda", "node", "--test", "calendar.test.mjs", variables={
        "PICKUP_WINDOW": str(MODULES / "pickup-window"),
    })
    for module, demo in [
        ("pass-rail", "kitchen-demo.mjs"), ("prep-sheet", "kitchen-demo.mjs"),
        ("receipt-returns", "demo.mjs"), ("wallet-observer", "demo.mjs"), ("ready-range", "demo.mjs"),
    ]:
        run(module, "node", demo, ROOT)
    for module, demo, dependencies in [
        ("batch-clock", "pickup_demo.py", ["pickup-window"]),
        ("batch-waste", "demo.py", ["prep-sheet"]),
        ("dispatch-window", "resume_demo.py", ["stockroom-reservations"]),
        ("pantry-freight", "prep_demo.py", ["prep-sheet"]),
        ("plate-cost", "demo.py", ["prep-sheet", "receipt-returns"]),
        ("prep-sheet", "receiving_demo.py", ["pantry-freight"]),
        ("return-docket", "demo.py", ["stockroom-reservations"]),
    ]:
        run(module, PYTHON, demo, *(MODULES / dependency for dependency in dependencies))
    run("dispatch-window", PYTHON, "demo.py", MODULES / "stockroom-reservations", "--compare-stations")


def cashier():
    run("till-change", "dotnet", "build", "-c", "Release")
    run("till-change", PYTHON, "-m", "unittest", "-q")
    run("drawer-count", PYTHON, "-m", "unittest", "-q", variables={
        "TILL_CHANGE_DLL": str(MODULES / "till-change/bin/Release/net10.0/TillChange.dll"),
    })
    run("float-plan", PYTHON, "-m", "unittest", "-q")
    run("float-plan", PYTHON, "compare_register.py", MODULES / "till-change")


def printed_tables():
    with TemporaryDirectory() as work:
        output = Path(work) / "printed"
        run("table-scan-check", "node", "capture.mjs", ROOT, output)
        run("table-scan-check", PYTHON, "-m", "unittest", "-q", variables={
            "TABLE_QR_MANIFEST": str(output / "manifest.json"),
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = {"operations": kitchen_and_fulfillment, "cashier": cashier, "tables": printed_tables}
    parser.add_argument("suite", choices=commands)
    commands[parser.parse_args().suite]()
