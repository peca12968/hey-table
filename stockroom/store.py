"""Transactional stock reservations. One short-lived connection per operation."""
from contextlib import closing, contextmanager
from pathlib import Path
import re
import sqlite3
import time

DOCK_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
DOCK_SKU = re.compile(r"[A-Z0-9][A-Z0-9-]{0,31}")


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
CREATE TABLE IF NOT EXISTS fulfillments (
    reservation_id TEXT NOT NULL REFERENCES reservations(id),
    shipment_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    held_after INTEGER NOT NULL CHECK (held_after >= 0),
    PRIMARY KEY (reservation_id, shipment_id)
);
CREATE TABLE IF NOT EXISTS reservation_releases (
    reservation_id TEXT NOT NULL REFERENCES reservations(id),
    release_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    held_after INTEGER NOT NULL CHECK (held_after >= 0),
    PRIMARY KEY (reservation_id, release_id)
);
CREATE TABLE IF NOT EXISTS shipment_returns (
    reservation_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL,
    return_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    returnable_after INTEGER NOT NULL CHECK (returnable_after >= 0),
    PRIMARY KEY (reservation_id, shipment_id, return_id),
    FOREIGN KEY (reservation_id, shipment_id) REFERENCES fulfillments(reservation_id, shipment_id)
);
CREATE TABLE IF NOT EXISTS inbound_receipts (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 9999)
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
            if "shipped" not in columns:
                conn.execute("""ALTER TABLE reservations ADD COLUMN shipped INTEGER NOT NULL DEFAULT 0
                                CHECK (shipped BETWEEN 0 AND quantity)""")
            if "reduced" not in columns:
                conn.execute("""ALTER TABLE reservations ADD COLUMN reduced INTEGER NOT NULL DEFAULT 0
                                CHECK (reduced BETWEEN 0 AND quantity - shipped)""")
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
                FROM (SELECT sku, SUM(quantity - shipped - reduced) AS quantity FROM reservations
                      WHERE state='held' AND expires_at_ms<=? GROUP BY sku) AS due
                WHERE products.sku=due.sku
            """, (now,))
            conn.execute("""UPDATE reservations SET state='released', timed_out=1
                            WHERE state='held' AND expires_at_ms<=?""", (now,))
            yield conn, now

    @staticmethod
    def reservation(row):
        result = dict(row)
        shipped = result.pop("shipped")
        result.pop("reduced")
        if result.pop("timed_out"):
            result["state"] = "expired"
        elif shipped == result["quantity"]:
            result["state"] = "fulfilled"
        return result

    @staticmethod
    def find_reservation(conn, key):
        row = conn.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
        if row is None:
            raise Missing("Unknown reservation")
        return row

    def inventory(self):
        with self.current_inventory() as (conn, _):
            return [dict(row) for row in conn.execute("SELECT * FROM products ORDER BY sku")]

    def apply_receipts(self, records):
        applied = replayed = units = 0
        with self.current_inventory() as (conn, _):
            for receipt_id, sku, quantity in records:
                if (not isinstance(receipt_id, str) or not DOCK_ID.fullmatch(receipt_id) or
                        not isinstance(sku, str) or not DOCK_SKU.fullmatch(sku) or
                        type(quantity) is not int or not 1 <= quantity <= 9999):
                    raise ValueError("Invalid inbound receipt")
                prior = conn.execute("SELECT sku,quantity FROM inbound_receipts WHERE id=?", (receipt_id,)).fetchone()
                if prior is not None:
                    if tuple(prior) != (sku, quantity):
                        raise Conflict(f"Receipt {receipt_id} already recorded with different contents")
                    replayed += 1
                    continue
                product = conn.execute("SELECT capacity FROM products WHERE sku=?", (sku,)).fetchone()
                if product is None:
                    raise Missing(f"Unknown inbound SKU: {sku}")
                if product["capacity"] > 2**63 - 1 - quantity:
                    raise Conflict(f"Capacity exceeds SQLite integer range for {sku}")
                conn.execute("INSERT INTO inbound_receipts VALUES (?,?,?)", (receipt_id, sku, quantity))
                conn.execute("UPDATE products SET capacity=capacity+?, available=available+? WHERE sku=?",
                             (quantity, quantity, sku))
                applied += 1
                units += quantity
        return {"applied": applied, "replayed": replayed, "units_added": units}

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
            row = self.find_reservation(conn, key)
            if row["state"] == "held":
                conn.execute("UPDATE products SET available=available+? WHERE sku=?",
                             (self.held_units(row), row["sku"]))
                conn.execute("UPDATE reservations SET state='released' WHERE id=?", (key,))
                return self.reservation(row) | {"state": "released"}
            return self.reservation(row)

    @staticmethod
    def held_units(row):
        return row["quantity"] - row["shipped"] - row["reduced"] if row["state"] == "held" else 0

    def release_units(self, key, release_id, quantity):
        with self.current_inventory() as (conn, _):
            row = self.find_reservation(conn, key)
            receipt = conn.execute("""SELECT * FROM reservation_releases
                                      WHERE reservation_id=? AND release_id=?""", (key, release_id)).fetchone()
            if receipt:
                if receipt["quantity"] != quantity:
                    raise Conflict("Release key already used with different quantity")
                return dict(receipt), False
            held_after = self.held_units(row) - quantity
            if held_after < 0:
                raise Conflict("Release exceeds the remaining hold")
            conn.execute("UPDATE products SET available=available+? WHERE sku=?", (quantity, row["sku"]))
            conn.execute("UPDATE reservations SET reduced=reduced+?, state=? WHERE id=?",
                         (quantity, "held" if held_after else "released", key))
            conn.execute("INSERT INTO reservation_releases VALUES (?,?,?,?)", (key, release_id, quantity, held_after))
            return {"reservation_id": key, "release_id": release_id, "quantity": quantity, "held_after": held_after}, True

    def progress(self, key):
        with self.current_inventory() as (conn, _):
            row = self.find_reservation(conn, key)
            outstanding = row["quantity"] - row["shipped"]
            held = self.held_units(row)
            return self.reservation(row) | {"shipped": row["shipped"], "held": held,
                                            "returned": outstanding - held}

    def fulfill(self, key, shipment_id, quantity):
        with self.current_inventory() as (conn, _):
            row = self.find_reservation(conn, key)
            receipt = conn.execute("""SELECT * FROM fulfillments
                                      WHERE reservation_id=? AND shipment_id=?""", (key, shipment_id)).fetchone()
            if receipt:
                if receipt["quantity"] != quantity:
                    raise Conflict("Shipment key already used with different quantity")
                return dict(receipt), False
            held_after = self.held_units(row) - quantity
            if held_after < 0:
                raise Conflict("Insufficient held units for shipment")
            # Reserving already deducted availability. Dispatch removes physical units.
            conn.execute("UPDATE products SET capacity=capacity-? WHERE sku=?", (quantity, row["sku"]))
            conn.execute("""UPDATE reservations SET shipped=shipped+?, state=? WHERE id=?""",
                         (quantity, "held" if held_after else "released", key))
            conn.execute("INSERT INTO fulfillments(reservation_id, shipment_id, quantity, held_after) VALUES (?,?,?,?)",
                         (key, shipment_id, quantity, held_after))
            return {"reservation_id": key, "shipment_id": shipment_id, "quantity": quantity,
                    "held_after": held_after}, True

    @staticmethod
    def shipment_balance(conn, key, shipment_id):
        row = conn.execute("""
            SELECT f.reservation_id, f.shipment_id, f.quantity AS dispatched, r.sku,
                   COALESCE((SELECT SUM(sr.quantity) FROM shipment_returns sr
                             WHERE sr.reservation_id=f.reservation_id AND sr.shipment_id=f.shipment_id), 0)
                       AS restocked
            FROM fulfillments f JOIN reservations r ON r.id=f.reservation_id
            WHERE f.reservation_id=? AND f.shipment_id=?
        """, (key, shipment_id)).fetchone()
        if row is None:
            raise Missing("Unknown shipment")
        return dict(row) | {"returnable": row["dispatched"] - row["restocked"]}

    def shipment(self, key, shipment_id):
        with closing(self.connect()) as conn:
            return self.shipment_balance(conn, key, shipment_id)

    def restock(self, key, shipment_id, return_id, quantity):
        with self.current_inventory() as (conn, _):
            ids = (key, shipment_id, return_id)
            receipt = conn.execute("""SELECT * FROM shipment_returns
                                      WHERE reservation_id=? AND shipment_id=? AND return_id=?""", ids).fetchone()
            if receipt:
                if receipt["quantity"] != quantity:
                    raise Conflict("Return key already used with different quantity")
                return dict(receipt), False
            balance = self.shipment_balance(conn, key, shipment_id)
            remaining = balance["returnable"] - quantity
            if remaining < 0:
                raise Conflict("Return exceeds the units outstanding for this shipment")
            conn.execute("""UPDATE products SET capacity=capacity+?, available=available+? WHERE sku=?""",
                         (quantity, quantity, balance["sku"]))
            conn.execute("""INSERT INTO shipment_returns(reservation_id, shipment_id, return_id, quantity,
                                                        returnable_after) VALUES (?, ?, ?, ?, ?)""",
                         (*ids, quantity, remaining))
            return {"reservation_id": key, "shipment_id": shipment_id, "return_id": return_id,
                    "quantity": quantity, "returnable_after": remaining}, True
