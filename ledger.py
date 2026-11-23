"""Record kitchen deliveries, completed prep batches and order issues in SQLite."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from prep import catalog, dish_demand, integer, order_identity, quantities


def initialize(path):
    # Exclusive creation keeps accidental initialization away from an existing kitchen database.
    with path.open("xb"):
        pass
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
            BEGIN;
            CREATE TABLE balances (
                component TEXT PRIMARY KEY, unit TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>=0)
            );
            CREATE TABLE receipts (
                id INTEGER PRIMARY KEY, kind TEXT NOT NULL, reference TEXT NOT NULL,
                posted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                request TEXT NOT NULL, movements TEXT NOT NULL, UNIQUE(kind,reference)
            );
            COMMIT;
        """)


def connect(path, mode):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=" + mode, uri=True, timeout=15)


def inventory_snapshot(path, book):
    with closing(connect(path, "ro")) as db:
        db.execute("BEGIN")
        stock = {}
        for key, unit, quantity in db.execute("SELECT component,unit,quantity FROM balances"):
            if book["components"].get(key, {}).get("unit") != unit:
                raise ValueError(f"{key}: ledger and recipe units differ")
            stock[key] = quantity
        issued = {int(ref): json.loads(request) for ref, request in db.execute(
            "SELECT reference,request FROM receipts WHERE kind='issue'")}
        return stock, issued


def describe(row):
    number, kind, ref, posted, changes = row
    return {"receipt": number, "kind": kind, "reference": ref, "posted_at": posted,
            "movements": json.loads(changes)}


FIELDS = "id,kind,reference,posted_at,movements"


def post(path, book, kind, reference, payload):
    components, _, revisions = catalog(book)
    if not isinstance(reference, str) or not reference.strip():
        raise ValueError("Missing movement reference")
    if kind == "receive":
        changes = quantities(payload, components, 1, "delivery")
        if not changes:
            raise ValueError("An empty delivery cannot be posted")
        identity = changes
    elif kind == "make":
        component = payload["component"]
        count = integer(payload["batches"], 1, "batches")
        recipe = components[component]
        if "inputs" not in recipe:
            raise ValueError(f"{component} has no prep recipe")
        changes = {key: -amount * count for key, amount in recipe["inputs"].items()}
        changes[component] = recipe["yield"] * count
        identity = {"component": component, "batches": count}
    elif kind == "issue":
        if reference != str(integer(payload["id"], 1, "order ID")):
            raise ValueError("Issue reference must match the order ID")
        identity = order_identity(payload)
    else:
        raise ValueError(f"Unknown operation {kind}")

    request = json.dumps(identity, sort_keys=True)
    with closing(connect(path, "rw")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute(f"SELECT {FIELDS},request FROM receipts WHERE kind=? AND reference=?",
                              (kind, reference)).fetchone()
        if previous:
            if previous[-1] != request:
                raise ValueError(f"{kind} {reference}: reference already used with different quantities or items")
            return describe(previous[:-1])
        if kind == "issue":
            if payload["status"] not in ("pending", "preparing"):
                raise ValueError(f"Order {reference} is no longer awaiting ingredients")
            wanted, _ = dish_demand(payload, book, revisions)
            changes = {key: -amount for key, amount in wanted.items()}

        movements = {}
        for key, delta in sorted(changes.items()):
            unit = components[key]["unit"]
            row = db.execute("SELECT unit,quantity FROM balances WHERE component=?", (key,)).fetchone()
            if row and unit != row[0]:
                raise ValueError(f"{key}: ledger and recipe units differ")
            previous_quantity = row[1] if row else 0
            quantity = previous_quantity + delta
            if quantity < 0:
                raise ValueError(f"{key}: need {-delta} {unit}, only {previous_quantity} available")
            if quantity > 2**63 - 1:
                raise ValueError(f"{key}: balance exceeds SQLite integer range")
            db.execute("""INSERT INTO balances VALUES(?,?,?) ON CONFLICT(component)
                          DO UPDATE SET quantity=excluded.quantity""", (key, unit, quantity))
            movements[key] = {"unit": unit, "delta": delta, "balance": quantity}
        number = db.execute("INSERT INTO receipts(kind,reference,request,movements) VALUES(?,?,?,?)",
                            (kind, reference, request, json.dumps(movements))).lastrowid
        return describe(db.execute(f"SELECT {FIELDS} FROM receipts WHERE id=?", (number,)).fetchone())


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--recipes", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init")
    commands.add_parser("history")
    receive = commands.add_parser("receive")
    receive.add_argument("reference")
    receive.add_argument("quantities", type=Path)
    make = commands.add_parser("make")
    make.add_argument("reference")
    make.add_argument("component")
    make.add_argument("batches", type=int)
    issue = commands.add_parser("issue")
    issue.add_argument("orders", type=Path)
    issue.add_argument("order_id", type=int)
    args = parser.parse_args()
    try:
        if args.command == "init":
            initialize(args.db)
            result = {"database": str(args.db)}
        elif args.command == "history":
            with closing(connect(args.db, "ro")) as db:
                result = [describe(row) for row in db.execute(f"SELECT {FIELDS} FROM receipts ORDER BY id")]
        else:
            if not args.recipes:
                parser.error("--recipes is required when recording a movement")
            book = read_json(args.recipes)
            if args.command == "issue":
                matches = [o for o in read_json(args.orders) if o["id"] == args.order_id]
                if len(matches) != 1:
                    raise ValueError("Expected exactly one matching order in the kitchen export")
                reference, payload = str(args.order_id), matches[0]
            elif args.command == "make":
                reference, payload = args.reference, {"component": args.component, "batches": args.batches}
            else:
                reference, payload = args.reference, read_json(args.quantities)
            result = post(args.db, book, args.command, reference, payload)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, sqlite3.Error, TypeError, ValueError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
