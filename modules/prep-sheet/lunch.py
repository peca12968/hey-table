"""Plan kitchen prep and supplier purchases from the same order snapshot."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

from ledger import inventory_snapshot
from prep import plan
from receiving import procurement_snapshot

# Pantry Freight is a sibling module in the unified repository.
sys.path.append(str(Path(__file__).resolve().parents[1] / "pantry-freight"))
from purchase import purchase, read_json


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--orders", type=Path, required=True, help="Kitchen JSON export")
    parser.add_argument("--recipes", type=Path, required=True)
    parser.add_argument("--suppliers", type=Path, required=True)
    inventory = parser.add_mutually_exclusive_group(required=True)
    inventory.add_argument("--stock", type=Path)
    inventory.add_argument("--ledger", type=Path, help="Read balances and skip already-issued orders")
    parser.add_argument("--incoming", action="append", default=[], metavar="PURCHASE_ORDER",
                        help="Subtract an existing order's undelivered quantities from new purchases")
    parser.add_argument("--include-preparing", action="store_true")
    parser.add_argument("--purchase-only", action="store_true", help="Export a report for receiving.py open")
    args = parser.parse_args(argv)
    if args.incoming and not args.ledger:
        parser.error("--incoming requires --ledger")

    try:
        orders = read_json(args.orders)
        if not isinstance(orders, list):
            raise ValueError("Orders must be a JSON array")
        book = read_json(args.recipes)
        incoming = {}
        if args.incoming:
            stock, issued, incoming = procurement_snapshot(args.ledger, book, args.incoming)
        elif args.ledger:
            stock, issued = inventory_snapshot(args.ledger, book)
        else:
            stock, issued = read_json(args.stock), {}
        prep = plan(orders, book, stock, args.include_preparing, issued)
        report = purchase(prep, read_json(args.suppliers), incoming=incoming)
    except (OSError, sqlite3.Error, TypeError, ValueError, KeyError, AttributeError) as error:
        parser.exit(2, f"{error}\n")

    combined = {"prep": prep, "purchase": report}
    if args.incoming:
        combined["incoming"] = incoming
    print(json.dumps(report if args.purchase_only else combined, indent=2))
    return 0 if report["status"] == "ok" else 3


if __name__ == "__main__":
    sys.exit(main())
