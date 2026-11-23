"""SQLite-backed partial-return simulation for a single restaurant."""
import argparse
from collections import Counter
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import sys

from pricing import allocate, integer, price_lots


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def connect(path):
    db = sqlite3.connect(path, isolation_level=None, timeout=10)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS receipts (
            id INTEGER PRIMARY KEY, created INTEGER NOT NULL, total INTEGER NOT NULL, lots TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entries (
            receipt INTEGER NOT NULL REFERENCES receipts(id), request TEXT NOT NULL,
            selection TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(receipt, request)
        );
    """)
    return db


@contextmanager
def transaction(db, write):
    db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
    try:
        yield
        db.commit()
    except BaseException:
        db.rollback()
        raise


def register(db, ticket):
    rid = integer(ticket["id"], 1)
    snapshot = (integer(ticket["created"]), integer(ticket["total"]), encode(price_lots(ticket)))
    with transaction(db, True):
        old = db.execute("SELECT created,total,lots FROM receipts WHERE id=?", (rid,)).fetchone()
        if old and old != snapshot:
            raise ValueError("Order number already has a different receipt")
        if old is None:
            db.execute("INSERT INTO receipts VALUES (?,?,?,?)", (rid, *snapshot))
    return {"receipt": rid, "total": ticket["total"]}


def history(db, rid):
    return [json.loads(row[0]) for row in db.execute(
        "SELECT result FROM entries WHERE receipt=? ORDER BY rowid", (rid,))]


def quote(db, rid, selection, *, request=None, expected=None):
    integer(rid, 1)
    recording = request is not None
    if recording:
        if not isinstance(request, str) or not request.strip():
            raise ValueError("Enter a request ID")
        integer(expected)
    with transaction(db, recording):
        row = db.execute("SELECT lots,total FROM receipts WHERE id=?", (rid,)).fetchone()
        if not row:
            raise ValueError("Unknown receipt")
        if recording:
            old = db.execute("SELECT selection,result FROM entries WHERE receipt=? AND request=?",
                             (rid, request)).fetchone()
            if old:
                result = json.loads(old[1])
                if old[0] != encode(selection) or result["amount"] != expected:
                    raise ValueError("Request ID already used for another selection or price")
                return result
        used = Counter()
        balance = row[1]
        for prior in history(db, rid):
            balance -= prior["amount"]
            for line in prior["lines"]:
                used[line["dish"]] += line["qty"]
        lines = allocate(json.loads(row[0]), used, selection)
        amount = sum(line["amount"] for line in lines)
        result = {"receipt": rid, "lines": lines, "amount": amount, "remainingValue": balance - amount}
        if recording:
            if amount != expected:
                raise ValueError(f"Preview again: expected {expected}, current amount {amount}")
            result["request"] = request
            db.execute("INSERT INTO entries VALUES (?,?,?,?)", (rid, request, encode(selection), encode(result)))
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("import").add_argument("ticket", type=Path)
    for name in ("preview", "record", "history"):
        sub = commands.add_parser(name)
        sub.add_argument("receipt", type=int)
        if name != "history":
            sub.add_argument("items", nargs="+", metavar="DISH=QTY")
        if name == "record":
            sub.add_argument("--request", required=True)
            sub.add_argument("--expected", required=True, type=int)
    args = parser.parse_args()
    db = connect(args.database)
    try:
        if args.command == "import":
            result = register(db, json.loads(args.ticket.read_text(encoding="utf-8")))
        elif args.command == "history":
            if not db.execute("SELECT 1 FROM receipts WHERE id=?", (args.receipt,)).fetchone():
                raise ValueError("Unknown receipt")
            result = history(db, args.receipt)
        else:
            selection = {}
            for item in args.items:
                dish, value = item.rsplit("=", 1)
                if dish in selection:
                    raise ValueError("Repeated dish")
                selection[dish] = int(value)
            result = quote(db, args.receipt, selection, request=getattr(args, "request", None),
                           expected=getattr(args, "expected", None))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, sqlite3.Error) as error:
        sys.exit(str(error))
