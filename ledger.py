"""Reconcile an order snapshot against signed settlement postings in minor units."""
import argparse
import csv
import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

SOURCES = {
    "orders": ("order_id", "currency", "amount_minor"),
    "postings": ("posting_id", "order_id", "currency", "amount_minor"),
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
    posting_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_order ON postings(order_id, currency);
"""


def parse_row(table, row):
    columns = SOURCES[table]
    if len(row) != len(columns):
        raise ValueError("unexpected column count")
    *ids, currency, amount = row
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", key) for key in ids):
        raise ValueError("invalid identifier")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("expected three uppercase currency letters")
    if not re.fullmatch(r"-?(0|[1-9][0-9]{0,11})", amount):
        raise ValueError("expected integer minor units, maximum 12 digits")
    return (*ids, currency, int(amount))


def import_feed(db, table, path):
    columns = SOURCES[table]
    placeholders = ", ".join("?" for _ in columns)
    duplicates = 0
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        if next(reader, None) != list(columns):
            raise ValueError(f"{path.name}: expected {','.join(columns)}")
        for line, raw in enumerate(reader, 2):
            try:
                if line > 1_000_001:
                    raise ValueError("maximum one million rows per feed")
                record = parse_row(table, raw)
                result = db.execute(f"INSERT OR IGNORE INTO {table} VALUES ({placeholders})", record)
                if not result.rowcount:
                    previous = db.execute(f"SELECT * FROM {table} WHERE {columns[0]}=?",
                                          (record[0],)).fetchone()
                    if tuple(previous) != record:
                        raise ValueError(f"conflicting duplicate ID {record[0]}")
                    duplicates += 1
            except ValueError as exc:
                raise ValueError(f"{path.name} line {line}: {exc}") from exc
    return duplicates


def reconcile(db, orders, postings):
    db.executescript(SCHEMA)
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("DELETE FROM orders")
        db.execute("DELETE FROM postings")
        ignored = {name: import_feed(db, name, path)
                   for name, path in [("orders", orders), ("postings", postings)]}
        sql = Path(__file__).with_name("reconcile.sql").read_text(encoding="utf-8")
        exceptions = []
        totals = {}
        matched = 0
        for row in db.execute(sql):
            order, currency, expected, received, state = row
            delta = (received or 0) - (expected or 0)
            total = totals.setdefault(currency, {"expected_minor": 0, "received_minor": 0, "delta_minor": 0})
            total["expected_minor"] += expected or 0
            total["received_minor"] += received or 0
            total["delta_minor"] += delta
            if state == "matched":
                matched += 1
            else:
                exceptions.append({"order_id": order, "currency": currency, "state": state,
                                   "expected_minor": expected, "received_minor": received, "delta_minor": delta})
    return {"matched": matched, "exceptions": exceptions, "by_currency": totals, "duplicates_ignored": ignored}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("orders", type=Path)
    parser.add_argument("postings", type=Path)
    parser.add_argument("--db", default=":memory:", help="SQLite snapshot destination")
    parser.add_argument("--strict", action="store_true", help="exit 3 when differences exist")
    args = parser.parse_args(argv)
    try:
        with closing(sqlite3.connect(args.db, timeout=15)) as db:
            report = reconcile(db, args.orders, args.postings)
    except (ValueError, OSError, csv.Error, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 3 if args.strict and report["exceptions"] else 0


if __name__ == "__main__":
    sys.exit(main())
