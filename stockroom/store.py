"""Transactional stock reservations. One short-lived connection per operation."""
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3
import time


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
    def __init__(self, path: Path, *, ttl_seconds=900, clock=time.time):
        if not 1 <= ttl_seconds <= 86_400:
            raise ValueError("Reservation TTL must be between 1 and 86400 seconds")
        self.path = path
        self.ttl_ms = ttl_seconds * 1000
        self.clock = clock

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
        with self.transaction() as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(reservations)")}
            if "expires_at_ms" not in columns:
                conn.execute("ALTER TABLE reservations ADD COLUMN expires_at_ms INTEGER")
                conn.execute("ALTER TABLE reservations ADD COLUMN timed_out INTEGER NOT NULL DEFAULT 0")
            conn.execute("""CREATE INDEX IF NOT EXISTS active_deadlines ON reservations(expires_at_ms)
                            WHERE state='held' AND expires_at_ms IS NOT NULL""")
            conn.execute("INSERT OR IGNORE INTO products VALUES ('KIT-01', 20, 20)")

    @contextmanager
    def transaction(self):
        with closing(self.connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            with conn:
                yield conn

    @contextmanager
    def current_inventory(self):
        with self.transaction() as conn:
            now = int(self.clock() * 1000)
            # Serialize deadline checks with holds and cancellations under the same write lock.
            conn.execute("""
                UPDATE products SET available=available+due.quantity
                FROM (SELECT sku, SUM(quantity) AS quantity FROM reservations
                      WHERE state='held' AND expires_at_ms<=? GROUP BY sku) AS due
                WHERE products.sku=due.sku
            """, (now,))
            conn.execute("""UPDATE reservations SET state='released', timed_out=1
                            WHERE state='held' AND expires_at_ms<=?""", (now,))
            yield conn, now

    @staticmethod
    def reservation(row):
        result = dict(row)
        if result.pop("timed_out"):
            result["state"] = "expired"
        return result

    def inventory(self):
        with self.current_inventory() as (conn, _):
            return [dict(row) for row in conn.execute("SELECT * FROM products ORDER BY sku")]

    def reserve(self, key, sku, quantity):
        with self.current_inventory() as (conn, now):
            existing = conn.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if existing:
                if (existing["sku"], existing["quantity"]) != (sku, quantity):
                    raise Conflict("Idempotency key already used with different input")
                return self.reservation(existing), False
            if not conn.execute("SELECT 1 FROM products WHERE sku=?", (sku,)).fetchone():
                raise Missing("Unknown SKU")
            updated = conn.execute(
                "UPDATE products SET available=available-? WHERE sku=? AND available>=?",
                (quantity, sku, quantity),
            )
            if updated.rowcount != 1:
                raise Conflict("Insufficient stock")
            expires_at_ms = now + self.ttl_ms
            conn.execute("""INSERT INTO reservations (id, sku, quantity, state, expires_at_ms)
                            VALUES (?, ?, ?, 'held', ?)""", (key, sku, quantity, expires_at_ms))
            return {"id": key, "sku": sku, "quantity": quantity, "state": "held",
                    "expires_at_ms": expires_at_ms}, True

    def release(self, key):
        with self.current_inventory() as (conn, _):
            row = conn.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
            if row is None:
                raise Missing("Unknown reservation")
            if row["state"] == "held":
                conn.execute("UPDATE products SET available=available+? WHERE sku=?",
                             (row["quantity"], row["sku"]))
                conn.execute("UPDATE reservations SET state='released' WHERE id=?", (key,))
                return self.reservation(row) | {"state": "released"}
            return self.reservation(row)
