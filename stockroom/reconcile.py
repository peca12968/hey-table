"""Explain the change in one SKU between two Stockroom SQLite snapshots."""

import argparse
from collections import Counter
from contextlib import closing
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import sys


@dataclass
class Snapshot:
    capacity: int
    available: int
    held: int
    receipts: dict
    issues: list

    def balances(self):
        return {
            "capacity": self.capacity,
            "available": self.available,
            "held": self.held,
        }


# Keys match the primary keys of the service, including per-shipment return IDs.
RECEIPT_QUERIES = {
    "inbound_receipts": (
        "inbound",
        "SELECT id, quantity FROM inbound_receipts WHERE sku=?",
    ),
    "fulfillments": (
        "dispatch",
        """SELECT f.reservation_id, f.shipment_id, f.quantity
        FROM fulfillments f JOIN reservations r ON r.id=f.reservation_id WHERE r.sku=?""",
    ),
    "shipment_returns": (
        "restock",
        """SELECT s.reservation_id, s.shipment_id, s.return_id, s.quantity
        FROM shipment_returns s JOIN reservations r ON r.id=s.reservation_id WHERE r.sku=?""",
    ),
    "reservation_releases": (
        "release",
        """SELECT s.reservation_id, s.release_id, s.quantity
        FROM reservation_releases s JOIN reservations r ON r.id=s.reservation_id WHERE r.sku=?""",
    ),
}


def read_snapshot(path, sku):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("BEGIN")
        tables = {
            name
            for (name,) in db.execute(
                "SELECT name FROM sqlite_schema WHERE type='table'"
            )
        }
        if not {"products", "reservations"} <= tables:
            raise ValueError(f"{path}: expected a Stockroom database")
        product = db.execute(
            "SELECT capacity, available FROM products WHERE sku=?", (sku,)
        ).fetchone()
        if product is None:
            raise ValueError(f"{path}: unknown SKU {sku}")
        columns = {row[1] for row in db.execute("PRAGMA table_info(reservations)")}
        receipts = {}
        totals = Counter()
        returns_by_box = Counter()
        for table, (kind, query) in RECEIPT_QUERIES.items():
            if table in tables:
                for *key, quantity in db.execute(query, (sku,)):
                    receipts[(kind, *key)] = quantity
                    if kind in ("dispatch", "release"):
                        totals[kind, key[0]] += quantity
                    elif kind == "restock":
                        returns_by_box[tuple(key[:2])] += quantity
        # Original databases predate both counters and their receipt tables.
        for column, table in (
            ("shipped", "fulfillments"),
            ("reduced", "reservation_releases"),
        ):
            if (column in columns) != (table in tables):
                raise ValueError(f"{path}: inconsistent schema for {table}")
        shipped = "shipped" if "shipped" in columns else "0"
        reduced = "reduced" if "reduced" in columns else "0"
        held = 0
        issues = []
        for box, restocked in sorted(returns_by_box.items()):
            dispatched = receipts.get(("dispatch", *box), 0)
            if restocked > dispatched:
                issues.append(
                    {
                        "reason": "excess_returns",
                        "ids": list(box),
                        "dispatched": dispatched,
                        "restocked": restocked,
                    }
                )
        for key, quantity, state, sent, released in db.execute(
            f"SELECT id, quantity, state, {shipped}, {reduced} FROM reservations WHERE sku=? ORDER BY id",
            (sku,),
        ):
            for kind, stored in (("dispatch", sent), ("release", released)):
                if stored != totals[kind, key]:
                    issues.append(
                        {
                            "reason": "reservation_counter",
                            "reservation": key,
                            "kind": kind,
                            "stored": stored,
                            "receipted": totals[kind, key],
                        }
                    )
            remaining = quantity - totals["dispatch", key] - totals["release", key]
            if remaining < 0:
                issues.append(
                    {
                        "reason": "overdrawn_reservation",
                        "reservation": key,
                        "ordered": quantity,
                        "excess": -remaining,
                    }
                )
            if state == "held":
                held += remaining
        capacity, available = product
        if available != capacity - held:
            issues.append(
                {
                    "reason": "availability",
                    "stored": available,
                    "expected": capacity - held,
                }
            )
        return Snapshot(capacity, available, held, receipts, issues)


def reconcile(opening, closing_snapshot, sku):
    before = read_snapshot(opening, sku)
    after = read_snapshot(closing_snapshot, sku)
    issues = [
        dict(issue, snapshot=label)
        for label, snapshot in (("opening", before), ("closing", after))
        for issue in snapshot.issues
    ]
    additions = []
    movement = {"inbound": 0, "dispatch": 0, "restock": 0, "release": 0}
    for key in sorted(before.receipts.keys() | after.receipts.keys()):
        kind, *ids = key
        previous = before.receipts.get(key)
        current = after.receipts.get(key)
        if previous is None:
            movement[kind] += current
            additions.append({"kind": kind, "ids": ids, "quantity": current})
        elif current != previous:
            issues.append(
                {
                    "reason": "missing_receipt"
                    if current is None
                    else "changed_receipt",
                    "kind": kind,
                    "ids": ids,
                    "opening": previous,
                    "closing": current,
                }
            )
    expected = (
        before.capacity
        + movement["inbound"]
        - movement["dispatch"]
        + movement["restock"]
    )
    difference = after.capacity - expected
    if difference:
        issues.append(
            {"reason": "capacity", "stored": after.capacity, "expected": expected}
        )
    return {
        "sku": sku,
        "opening": before.balances(),
        "closing": after.balances(),
        "new_units": movement,
        "new_receipts": additions,
        "expected_capacity": expected,
        "capacity_difference": difference,
        "balanced": not issues,
        "issues": issues,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("opening", type=Path)
    parser.add_argument("closing", type=Path)
    parser.add_argument("sku")
    args = parser.parse_args()
    try:
        result = reconcile(args.opening, args.closing, args.sku)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.exit(2, f"{parser.prog}: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["balanced"] else 1


if __name__ == "__main__":
    sys.exit(main())
