"""Open a restaurant backup or an exported payment snapshot for reconciliation."""

from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3


FORMAT = "hey-table.payment-snapshot.v1"
FIELDS = {"order_id", "reference", "trade_id", "merchant", "created", "state", "payment_method", "total"}
STATES = ("pending", "authorized", "paid", "failed", "cancelled", "partial", "refunded")
METHODS = ("card", "line_pay", "px_pay_plus", "jko_pay", "easy_wallet", "pi_wallet", "plus_pay")


def add_restaurant_source(parser):
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("database", nargs="?", type=Path, help="read-only Hey Table SQLite backup")
    source.add_argument("--restaurant-snapshot", type=Path, help="payment JSON exported from the kitchen")


def integer(value, start=0):
    return type(value) is int and start <= value <= 2**63 - 1


def identifier(value):
    return isinstance(value, str) and bool(value.strip())


def populate(db, snapshot, environment):
    if (not isinstance(snapshot, dict) or set(snapshot) != {"format", "capturedAt", "environment", "attempts"}
            or snapshot["format"] != FORMAT or snapshot["environment"] != environment
            or not integer(snapshot["capturedAt"]) or not isinstance(snapshot["attempts"], list)):
        raise ValueError("invalid restaurant snapshot or payment environment")
    orders = {}
    attempts = []
    for index, row in enumerate(snapshot["attempts"], 1):
        if (not isinstance(row, dict) or set(row) != FIELDS
                or not integer(row["order_id"], 1) or not integer(row["created"]) or not integer(row["total"])
                or row["state"] not in STATES or row["payment_method"] not in METHODS
                or not identifier(row["reference"]) or not identifier(row["merchant"])
                or (row["trade_id"] is not None and not identifier(row["trade_id"]))):
            raise ValueError(f"invalid restaurant snapshot attempt {index}")
        order = (row["order_id"], row["payment_method"], row["total"], environment)
        if orders.setdefault(row["order_id"], order) != order:
            raise ValueError(f"conflicting order details in restaurant snapshot for order {row['order_id']}")
        attempts.append(tuple(row[key] for key in ("reference", "trade_id", "merchant", "created", "state", "order_id")))
    db.executescript("""
        CREATE TABLE orders(id INTEGER PRIMARY KEY, payment_method TEXT, total INTEGER, payment_env TEXT);
        CREATE TABLE payment_attempts(reference TEXT PRIMARY KEY, trade_id TEXT UNIQUE, merchant TEXT,
            created INTEGER, state TEXT, order_id INTEGER);
    """)
    with db:
        db.executemany("INSERT INTO orders VALUES (?,?,?,?)", orders.values())
        db.executemany("INSERT INTO payment_attempts VALUES (?,?,?,?,?,?)", attempts)


@contextmanager
def open_restaurant(database, snapshot, environment):
    if snapshot is not None:
        data = json.loads(snapshot.read_text(encoding="utf-8-sig"))
        with closing(sqlite3.connect(":memory:")) as db:
            populate(db, data, environment)
            db.execute("PRAGMA query_only=ON")
            yield db
    else:
        with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            yield db
