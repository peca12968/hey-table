"""Transactional stock reservations. One short-lived connection per operation."""
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3


class Conflict(Exception):
    pass


class Missing(Exception):
    pass


SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY,
    capacity INTEGER NOT NULL CHECK (capacity >= 0),
    available INTEGER NOT NULL CHECK (available BETWEEN 0 AND capacity)
);
CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    state TEXT NOT NULL CHECK (state IN ('held', 'released'))
);
"""


class Store:
    def __init__(self, path: Path):
        self.path = path

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            conn.execute("INSERT OR IGNORE INTO products VALUES ('KIT-01', 20, 20)")

    @contextmanager
    def transaction(self):
        with closing(self.connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            with conn:
                yield conn

    def inventory(self):
        with closing(self.connect()) as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM products ORDER BY sku")]

    def reserve(self, key, sku, quantity):
        with self.transaction() as conn:
            existing = conn.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if existing:
                if (existing["sku"], existing["quantity"]) != (sku, quantity):
                    raise Conflict("Idempotency key already used with different input")
                return dict(existing), False
            if not conn.execute("SELECT 1 FROM products WHERE sku=?", (sku,)).fetchone():
                raise Missing("Unknown SKU")
            updated = conn.execute(
                "UPDATE products SET available=available-? WHERE sku=? AND available>=?",
                (quantity, sku, quantity),
            )
            if updated.rowcount != 1:
                raise Conflict("Insufficient stock")
            conn.execute("INSERT INTO reservations VALUES (?, ?, ?, 'held')", (key, sku, quantity))
            return {"id": key, "sku": sku, "quantity": quantity, "state": "held"}, True

    def release(self, key):
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if row is None:
                raise Missing("Unknown reservation")
            if row["state"] == "held":
                conn.execute("UPDATE products SET available=available+? WHERE sku=?",
                             (row["quantity"], row["sku"]))
                conn.execute("UPDATE reservations SET state='released' WHERE id=?", (key,))
            return dict(row) | {"state": "released"}
