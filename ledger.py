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
SOURCE_AMOUNTS = """
SELECT 'orders' AS source, order_id AS record_id, order_id, currency, amount_minor FROM orders
UNION ALL
SELECT 'postings', posting_id, order_id, currency, amount_minor FROM postings
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


def exception_record(order, currency, expected, received, state):
    return {"order_id": order, "currency": currency, "state": state,
            "expected_minor": expected, "received_minor": received,
            "delta_minor": (received or 0) - (expected or 0)}


def explain_movements(db, totals):
    opening = dict(db.execute("""
        SELECT currency, SUM(CASE source WHEN 'orders' THEN -amount_minor ELSE amount_minor END)
        FROM temp.prior_amounts GROUP BY currency
    """))
    movements = {}
    for currency in sorted(opening.keys() | totals.keys()):
        before = opening.get(currency, 0)
        after = totals[currency]["delta_minor"] if currency in totals else 0
        movements[currency] = {"opening_delta_minor": before, "closing_delta_minor": after,
                               "change_minor": after - before, "lines": []}
    # The source table's primary key is already unique. Grouping also by order
    # and currency splits a reassigned posting into its outgoing and incoming legs.
    rows = db.execute(f"""
        WITH current_amounts AS ({SOURCE_AMOUNTS}),
        versions AS (
            SELECT source, record_id, order_id, currency, amount_minor AS old, NULL AS new
            FROM temp.prior_amounts
            UNION ALL
            SELECT source, record_id, order_id, currency, NULL, amount_minor FROM current_amounts
        )
        SELECT source, record_id, order_id, currency, MAX(old), MAX(new) FROM versions
        GROUP BY currency, source, record_id, order_id
        HAVING MAX(old) IS NOT MAX(new)
        ORDER BY currency, source, record_id, order_id
    """)
    for source, key, order, currency, old, new in rows:
        difference = (new or 0) - (old or 0)
        effect = -difference if source == "orders" else difference
        movements[currency]["lines"].append({"source": source, "record_id": key, "order_id": order,
                                            "before_minor": old, "after_minor": new, "effect_minor": effect})
    for currency, movement in movements.items():
        if sum(line["effect_minor"] for line in movement["lines"]) != movement["change_minor"]:
            raise ValueError(f"Movement total does not balance for {currency}")
    return movements


def reconcile(db, orders, postings, *, track_changes=False, explain=False):
    sql = Path(__file__).with_name("reconcile.sql").read_text(encoding="utf-8")
    db.executescript(SCHEMA)
    with db:
        db.execute("BEGIN IMMEDIATE")
        if explain:
            db.execute("CREATE TEMP TABLE prior_amounts AS " + SOURCE_AMOUNTS)
        previous = {}
        changes = {"new": [], "ongoing": [], "resolved": [], "absent": []}
        if track_changes:
            previous = {(row[0], row[1]): exception_record(*row)
                        for row in db.execute(sql) if row[4] != "matched"}
        db.execute("DELETE FROM orders")
        db.execute("DELETE FROM postings")
        ignored = {name: import_feed(db, name, path)
                   for name, path in [("orders", orders), ("postings", postings)]}
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
            before = previous.pop((order, currency), None) if track_changes else None
            if state == "matched":
                matched += 1
                if before is not None:
                    changes["resolved"].append({"before": before, "matched_minor": expected})
            else:
                after = exception_record(*row)
                exceptions.append(after)
                if track_changes:
                    if before is None:
                        changes["new"].append(after)
                    else:
                        changes["ongoing"].append({"before": before, "after": after})
        if explain:
            movements = explain_movements(db, totals)
            db.execute("DROP TABLE temp.prior_amounts")
    report = {"matched": matched, "exceptions": exceptions, "by_currency": totals, "duplicates_ignored": ignored}
    if track_changes:
        changes["absent"] = list(previous.values())
        report["changes"] = changes
    if explain:
        report["movements_by_currency"] = movements
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("orders", type=Path)
    parser.add_argument("postings", type=Path)
    parser.add_argument("--db", default=":memory:", help="SQLite snapshot destination")
    parser.add_argument("--strict", action="store_true", help="exit 3 when differences exist")
    parser.add_argument("--changes", action="store_true",
                        help="compare with the last successful snapshot in the specified database")
    parser.add_argument("--explain", action="store_true",
                        help="explain each currency's change in net difference using source records")
    args = parser.parse_args(argv)
    if (args.changes or args.explain) and args.db in ("", ":memory:"):
        parser.error("snapshot comparison requires a persistent --db FILE")
    try:
        with closing(sqlite3.connect(args.db, timeout=15)) as db:
            report = reconcile(db, args.orders, args.postings, track_changes=args.changes, explain=args.explain)
    except (ValueError, OSError, csv.Error, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 3 if args.strict and report["exceptions"] else 0


if __name__ == "__main__":
    sys.exit(main())
