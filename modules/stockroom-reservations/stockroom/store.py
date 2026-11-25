"""Transactional stock reservations. One short-lived connection per operation."""
from contextlib import closing, contextmanager
from itertools import groupby
from pathlib import Path
import re
import sqlite3
import time
from uuid import uuid4

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
CREATE TABLE IF NOT EXISTS reservation_replacements (
    source_id TEXT PRIMARY KEY REFERENCES reservations(id),
    replacement_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
    request_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    initial_expires_at_ms INTEGER NOT NULL,
    CHECK (source_id <> replacement_id AND created_at_ms < initial_expires_at_ms)
);
CREATE TABLE IF NOT EXISTS reservation_batch_items (
    batch_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
    initial_expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (batch_id, reservation_id)
);
CREATE TABLE IF NOT EXISTS reservation_batch_replacements (
    source_batch_id TEXT PRIMARY KEY,
    replacement_batch_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    CHECK (source_batch_id <> replacement_batch_id)
);
CREATE TABLE IF NOT EXISTS reservation_batch_cancellations (
    batch_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    cancelled_at_ms INTEGER NOT NULL,
    quantity_released INTEGER NOT NULL CHECK (quantity_released >= 0),
    PRIMARY KEY (batch_id, reservation_id),
    FOREIGN KEY (batch_id, reservation_id) REFERENCES reservation_batch_items(batch_id, reservation_id)
);
CREATE TABLE IF NOT EXISTS fulfillments (
    reservation_id TEXT NOT NULL REFERENCES reservations(id),
    shipment_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    held_after INTEGER NOT NULL CHECK (held_after >= 0),
    PRIMARY KEY (reservation_id, shipment_id)
);
CREATE TABLE IF NOT EXISTS dispatch_batch_boxes (
    batch_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL,
    PRIMARY KEY (reservation_id, shipment_id),
    FOREIGN KEY (reservation_id, shipment_id) REFERENCES fulfillments(reservation_id, shipment_id)
);
CREATE INDEX IF NOT EXISTS dispatch_batch_lookup ON dispatch_batch_boxes(batch_id, reservation_id, shipment_id);
CREATE TABLE IF NOT EXISTS reservation_releases (
    reservation_id TEXT NOT NULL REFERENCES reservations(id),
    release_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    held_after INTEGER NOT NULL CHECK (held_after >= 0),
    released_at_ms INTEGER,
    PRIMARY KEY (reservation_id, release_id)
);
CREATE INDEX IF NOT EXISTS release_timeline ON reservation_releases(reservation_id, held_after);
CREATE TABLE IF NOT EXISTS reservation_release_batches (
    batch_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    released_at_ms INTEGER NOT NULL,
    PRIMARY KEY (batch_id, reservation_id),
    UNIQUE (reservation_id, release_id),
    FOREIGN KEY (reservation_id, release_id) REFERENCES reservation_releases(reservation_id, release_id)
);
CREATE TABLE IF NOT EXISTS reservation_renewals (
    reservation_id TEXT NOT NULL REFERENCES reservations(id),
    renewal_id TEXT NOT NULL,
    previous_expires_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > previous_expires_at_ms),
    PRIMARY KEY (reservation_id, renewal_id)
);
CREATE TABLE IF NOT EXISTS reservation_renewal_batches (
    batch_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL REFERENCES reservations(id),
    previous_expires_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > previous_expires_at_ms),
    PRIMARY KEY (batch_id, reservation_id)
);
CREATE INDEX IF NOT EXISTS renewal_timeline ON reservation_renewals(reservation_id, expires_at_ms DESC);
CREATE INDEX IF NOT EXISTS renewal_batch_timeline ON reservation_renewal_batches(reservation_id, expires_at_ms DESC);
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
CREATE TABLE IF NOT EXISTS return_batch_boxes (
    batch_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL,
    PRIMARY KEY (batch_id, reservation_id, shipment_id),
    FOREIGN KEY (reservation_id, shipment_id, batch_id)
        REFERENCES shipment_returns(reservation_id, shipment_id, return_id)
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
            release_columns = {row["name"] for row in conn.execute("PRAGMA table_info(reservation_releases)")}
            if "released_at_ms" not in release_columns:
                conn.execute("ALTER TABLE reservation_releases ADD COLUMN released_at_ms INTEGER")
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
        return self.inventory_snapshot()["products"]

    def inventory_snapshot(self):
        with self.current_inventory() as (conn, now):
            products = [dict(row) for row in conn.execute("SELECT * FROM products ORDER BY sku")]
            return {"captured_at_ms": now, "products": products}

    def expiring_reservations(self, within_seconds, limit, sku, through_ms, after):
        with self.current_inventory() as (conn, now):
            if through_ms is not None and through_ms > now + 86_400_000:
                raise ValueError("Queue horizon must be within 24 hours")
            through = through_ms if through_ms is not None else now + within_seconds * 1000
            rows = conn.execute("""SELECT r.id AS reservation_id, r.sku, r.expires_at_ms, r.shipped,
                                    r.quantity - r.shipped - r.reduced AS held, b.batch_id
                                    FROM reservations r
                                    LEFT JOIN reservation_batch_items b ON b.reservation_id=r.id
                                    WHERE r.state='held' AND r.expires_at_ms>? AND r.expires_at_ms<=?
                                    AND r.quantity > r.shipped + r.reduced
                                    AND (? IS NULL OR r.sku=?)
                                    AND (? IS NULL OR (r.expires_at_ms, r.id) > (?,?))
                                    ORDER BY r.expires_at_ms, r.id LIMIT ?""",
                                (now, through, sku, sku, after[0], *after, limit + 1)).fetchall()
            items = [dict(row) for row in rows[:limit]]
            next_page = None
            if len(rows) > limit:
                last = items[-1]
                next_page = {"through_ms": through, "after_expires_at_ms": last["expires_at_ms"],
                             "after_id": last["reservation_id"]}
            return {"captured_at_ms": now, "through_ms": through, "reservations": items, "next": next_page}

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
            expires_at_ms = now + self.ttl_ms
            self.create_hold(conn, key, sku, quantity, expires_at_ms)
            return {"id": key, "sku": sku, "quantity": quantity, "state": "held",
                    "expires_at_ms": expires_at_ms}, True

    @staticmethod
    def create_hold(conn, key, sku, quantity, expires_at_ms):
        if not conn.execute("SELECT 1 FROM products WHERE sku=?", (sku,)).fetchone():
            raise Missing("Unknown SKU")
        updated = conn.execute(
            "UPDATE products SET available=available-? WHERE sku=? AND available>=?",
            (quantity, sku, quantity),
        )
        if updated.rowcount != 1:
            raise Conflict("Insufficient stock")
        conn.execute("""INSERT INTO reservations (id, sku, quantity, state, expires_at_ms)
                        VALUES (?, ?, ?, 'held', ?)""", (key, sku, quantity, expires_at_ms))

    @staticmethod
    def replacement_record(conn, key):
        return conn.execute("""
            SELECT link.source_id,link.request_id,link.created_at_ms,link.initial_expires_at_ms,
                   replacement.id,replacement.sku,replacement.quantity
            FROM reservation_replacements link JOIN reservations replacement ON replacement.id=link.replacement_id
            WHERE link.source_id=?
        """, (key,)).fetchone()

    @staticmethod
    def replacement_receipt(row):
        return {
            "source_id": row["source_id"], "created_at_ms": row["created_at_ms"],
            "reservation": {"id": row["id"], "sku": row["sku"], "quantity": row["quantity"],
                            "expires_at_ms": row["initial_expires_at_ms"]},
        }

    def replace_expired(self, key, request_id):
        with self.current_inventory() as (conn, now):
            existing = self.replacement_record(conn, key)
            if existing:
                if existing["request_id"] != request_id:
                    raise Conflict("Reservation already has a replacement")
                return self.replacement_receipt(existing), False
            original = self.find_reservation(conn, key)
            if not original["timed_out"]:
                raise Conflict("Only an expired reservation can be replaced")
            if conn.execute("""SELECT 1 FROM reservation_batch_items
                               JOIN reservation_batch_cancellations USING (batch_id, reservation_id)
                               WHERE reservation_id=?""", (key,)).fetchone():
                raise Conflict("Reservation batch was cancelled")
            self.create_replacement(conn, original, request_id, now, now + self.ttl_ms)
            return self.replacement_receipt(self.replacement_record(conn, key)), True

    def create_replacement(self, conn, original, request_id, now, expires_at_ms):
        quantity = original["quantity"] - original["shipped"] - original["reduced"]
        if quantity <= 0:
            raise Conflict("No expired units to replace")
        replacement_id = uuid4().hex
        self.create_hold(conn, replacement_id, original["sku"], quantity, expires_at_ms)
        conn.execute("""INSERT INTO reservation_replacements
                        (source_id,replacement_id,request_id,created_at_ms,initial_expires_at_ms)
                        VALUES (?,?,?,?,?)""", (original["id"], replacement_id, request_id, now, expires_at_ms))
        return replacement_id

    def get_replacement(self, key):
        with closing(self.connect()) as conn:
            record = self.replacement_record(conn, key)
            if record is None:
                raise Missing("Unknown reservation replacement")
            return self.replacement_receipt(record)

    @staticmethod
    def reservation_batch(conn, batch_id):
        rows = conn.execute("""SELECT r.id, r.sku, r.quantity, b.initial_expires_at_ms
                               FROM reservation_batch_items b JOIN reservations r ON r.id=b.reservation_id
                               WHERE b.batch_id=? ORDER BY r.sku""", (batch_id,)).fetchall()
        if not rows:
            return None
        return {
            "batch_id": batch_id,
            "expires_at_ms": rows[0]["initial_expires_at_ms"],
            "items": [{"id": row["id"], "sku": row["sku"], "quantity": row["quantity"]} for row in rows],
        }

    def reserve_batch(self, batch_id, items):
        items = sorted(items)
        with self.current_inventory() as (conn, now):
            receipt = self.reservation_batch(conn, batch_id)
            if receipt:
                if [(item["sku"], item["quantity"]) for item in receipt["items"]] != items:
                    raise Conflict("Reservation batch key already used with different items")
                return receipt, False
            expires_at_ms = now + self.ttl_ms
            for sku, quantity in items:
                key = uuid4().hex
                try:
                    self.create_hold(conn, key, sku, quantity, expires_at_ms)
                except (Conflict, Missing) as error:
                    raise type(error)(f"{sku}: {error}") from error
                conn.execute("INSERT INTO reservation_batch_items VALUES (?,?,?)",
                             (batch_id, key, expires_at_ms))
            return self.reservation_batch(conn, batch_id), True

    def reservation_batch_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            receipt = self.reservation_batch(conn, batch_id)
            if receipt is None:
                raise Missing("Unknown reservation batch")
            return receipt

    @staticmethod
    def reservation_batch_members(conn, batch_id):
        return conn.execute("""SELECT r.* FROM reservation_batch_items b
                               JOIN reservations r ON r.id=b.reservation_id
                               WHERE b.batch_id=? ORDER BY r.sku""", (batch_id,)).fetchall()

    @staticmethod
    def batch_replacement_record(conn, batch_id):
        rows = conn.execute("""
            SELECT h.request_id,h.created_at_ms,h.replacement_batch_id,b.initial_expires_at_ms,
                   link.source_id,r.id,r.sku,r.quantity
            FROM reservation_batch_replacements h
            JOIN reservation_batch_items b ON b.batch_id=h.replacement_batch_id
            JOIN reservation_replacements link ON link.replacement_id=b.reservation_id
            JOIN reservations r ON r.id=b.reservation_id
            WHERE h.source_batch_id=? ORDER BY r.sku
        """, (batch_id,)).fetchall()
        if not rows:
            return None
        first = rows[0]
        receipt = {
            "source_batch_id": batch_id, "batch_id": first["replacement_batch_id"],
            "created_at_ms": first["created_at_ms"], "expires_at_ms": first["initial_expires_at_ms"],
            "items": [{name: row[name] for name in ("source_id", "id", "sku", "quantity")} for row in rows],
        }
        return first["request_id"], receipt

    def batch_replacement_plan(self, conn, batch_id):
        members = self.reservation_batch_members(conn, batch_id)
        if not members:
            raise Missing("Unknown reservation batch")
        available = {row["sku"]: row["available"] for row in self.products_for(conn, (row["sku"] for row in members))}
        linked = {row["source_id"]: row["replacement_id"] for row in conn.execute("""
            SELECT link.source_id,link.replacement_id FROM reservation_batch_items b
            JOIN reservation_replacements link ON link.source_id=b.reservation_id WHERE b.batch_id=?
        """, (batch_id,))}
        items = []
        for row in members:
            sku, source_id = row["sku"], row["id"]
            quantity = row["quantity"] - row["shipped"] - row["reduced"] if row["timed_out"] else 0
            if sku not in available:
                raise Missing(f"{sku}: Unknown SKU")
            on_hand = available[sku]
            shortfall = max(0, quantity - on_hand)
            replacement_id = linked.get(source_id)
            if row["state"] == "held":
                status = "active"
            elif replacement_id is not None:
                status = "replaced"
            elif not quantity:
                status = "closed"
            else:
                status = "shortage" if shortfall else "ready"
            items.append({"source_id": source_id, "sku": sku, "expired_quantity": quantity,
                          "available": on_hand, "shortfall": shortfall, "status": status,
                          "replacement_id": replacement_id})
        cancelled = conn.execute("SELECT 1 FROM reservation_batch_cancellations WHERE batch_id=?", (batch_id,)).fetchone()
        blocked = next((item for item in items if item["status"] in ("replaced", "shortage")), None)
        if cancelled:
            status = "cancelled"
        elif any(item["status"] == "active" for item in items):
            status = "active"
        elif not any(item["expired_quantity"] for item in items):
            status = "none_expired"
        elif blocked:
            status = "item_replaced" if blocked["status"] == "replaced" else "shortage"
        else:
            status = "ready"
        return members, items, status, blocked

    def batch_replacement_preview(self, batch_id):
        with self.current_inventory() as (conn, now):
            _, items, status, _ = self.batch_replacement_plan(conn, batch_id)
            existing = self.batch_replacement_record(conn, batch_id)
            return {"source_batch_id": batch_id, "captured_at_ms": now, "items": items,
                    "status": "replaced" if existing else status,
                    "replacement_batch_id": existing[1]["batch_id"] if existing else None}

    def replace_expired_batch(self, batch_id, request_id):
        with self.current_inventory() as (conn, now):
            existing = self.batch_replacement_record(conn, batch_id)
            if existing:
                if request_id != existing[0]:
                    raise Conflict("Reservation batch already has a replacement")
                return existing[1], False
            members, items, status, blocked = self.batch_replacement_plan(conn, batch_id)
            if status != "ready":
                messages = {
                    "cancelled": "Reservation batch was cancelled",
                    "active": "Reservation batch still has active holds",
                    "none_expired": "Reservation batch has no expired holds",
                    "item_replaced": "Reservation already has a replacement",
                    "shortage": "Insufficient stock",
                }
                message = messages[status]
                if status in ("item_replaced", "shortage"):
                    message = f"{blocked['sku']}: {message}"
                raise Conflict(message)
            replacement_batch = uuid4().hex
            expires_at_ms = now + self.ttl_ms
            for row, item in zip(members, items, strict=True):
                if item["status"] != "ready":
                    continue
                # Individual request keys cannot contain a colon.
                key = self.create_replacement(conn, row, f"batch:{request_id}", now, expires_at_ms)
                conn.execute("INSERT INTO reservation_batch_items VALUES (?,?,?)",
                             (replacement_batch, key, expires_at_ms))
            conn.execute("INSERT INTO reservation_batch_replacements VALUES (?,?,?,?)",
                         (batch_id, replacement_batch, request_id, now))
            return self.batch_replacement_record(conn, batch_id)[1], True

    def get_batch_replacement(self, batch_id):
        with closing(self.connect()) as conn:
            existing = self.batch_replacement_record(conn, batch_id)
            if existing is None:
                raise Missing("Unknown reservation batch replacement")
            return existing[1]

    def reservation_batch_status(self, batch_id):
        with self.current_inventory() as (conn, now):
            receipt = self.reservation_batch(conn, batch_id)
            if receipt is None:
                raise Missing("Unknown reservation batch")
            members = self.reservation_batch_members(conn, batch_id)
            cancellation = conn.execute("""SELECT cancelled_at_ms FROM reservation_batch_cancellations
                                           WHERE batch_id=? LIMIT 1""", (batch_id,)).fetchone()
            return {
                "batch_id": batch_id,
                "captured_at_ms": now,
                "initial_expires_at_ms": receipt["expires_at_ms"],
                "cancelled_at_ms": cancellation["cancelled_at_ms"] if cancellation else None,
                "items": [self.progress_row(row) for row in members],
                "products": self.products_for(conn, (row["sku"] for row in members)),
            }

    @staticmethod
    def batch_cancellation(conn, batch_id):
        rows = conn.execute("""SELECT r.id, r.sku, c.cancelled_at_ms, c.quantity_released
                               FROM reservation_batch_cancellations c JOIN reservations r ON r.id=c.reservation_id
                               WHERE c.batch_id=? ORDER BY r.sku""", (batch_id,)).fetchall()
        if not rows:
            return None
        return {
            "batch_id": batch_id,
            "cancelled_at_ms": rows[0]["cancelled_at_ms"],
            "items": [{"id": row["id"], "sku": row["sku"], "quantity_released": row["quantity_released"]}
                      for row in rows],
        }

    def cancel_batch(self, batch_id):
        with self.current_inventory() as (conn, now):
            receipt = self.batch_cancellation(conn, batch_id)
            if receipt is not None:
                return receipt
            members = self.reservation_batch_members(conn, batch_id)
            if not members:
                raise Missing("Unknown reservation batch")
            for row in members:
                quantity = self.release_remaining(conn, row) or 0
                conn.execute("INSERT INTO reservation_batch_cancellations VALUES (?,?,?,?)",
                             (batch_id, row["id"], now, quantity))
            return self.batch_cancellation(conn, batch_id)

    def batch_cancellation_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            receipt = self.batch_cancellation(conn, batch_id)
            if receipt is None:
                raise Missing("Unknown reservation batch cancellation")
            return receipt

    def renew(self, key, renewal_id, expected_deadline, seconds):
        with self.current_inventory() as (conn, _):
            row = self.find_reservation(conn, key)
            deadline = expected_deadline + seconds * 1000
            receipt = conn.execute("""SELECT * FROM reservation_renewals
                                      WHERE reservation_id=? AND renewal_id=?""", (key, renewal_id)).fetchone()
            if receipt:
                if (receipt["previous_expires_at_ms"], receipt["expires_at_ms"]) != (expected_deadline, deadline):
                    raise Conflict("Renewal key already used with different input")
                return dict(receipt), False
            self.extend_held_deadline(conn, row, expected_deadline, deadline)
            conn.execute("""INSERT INTO reservation_renewals
                            (reservation_id, renewal_id, previous_expires_at_ms, expires_at_ms)
                            VALUES (?,?,?,?)""", (key, renewal_id, expected_deadline, deadline))
            return {"reservation_id": key, "renewal_id": renewal_id, "previous_expires_at_ms": expected_deadline,
                    "expires_at_ms": deadline}, True

    @staticmethod
    def extend_held_deadline(conn, row, expected_deadline, deadline):
        if row["state"] != "held" or row["expires_at_ms"] is None:
            raise Conflict("Only an active hold with a deadline can be renewed")
        if row["expires_at_ms"] != expected_deadline:
            raise Conflict("Reservation deadline changed")
        if deadline > 2**63 - 1:
            raise Conflict("Deadline exceeds SQLite integer range")
        conn.execute("UPDATE reservations SET expires_at_ms=? WHERE id=?", (deadline, row["id"]))

    @staticmethod
    def renewal_batch_rows(conn, batch_id):
        return [dict(row) for row in conn.execute("""SELECT reservation_id,previous_expires_at_ms,expires_at_ms
            FROM reservation_renewal_batches WHERE batch_id=? ORDER BY reservation_id""", (batch_id,))]

    def renew_batch(self, batch_id, items, seconds):
        requested = [(key, expected, expected + seconds * 1000) for key, expected in sorted(items)]
        with self.current_inventory() as (conn, _):
            receipts = self.renewal_batch_rows(conn, batch_id)
            if receipts:
                saved = [(row["reservation_id"], row["previous_expires_at_ms"], row["expires_at_ms"])
                         for row in receipts]
                if saved != requested:
                    raise Conflict("Renewal batch key already used with different input")
                return {"batch_id": batch_id, "items": receipts}, False
            for key, expected, deadline in requested:
                try:
                    self.extend_held_deadline(conn, self.find_reservation(conn, key), expected, deadline)
                except (Missing, Conflict) as error:
                    raise type(error)(f"{key}: {error}") from error
                conn.execute("INSERT INTO reservation_renewal_batches VALUES (?,?,?,?)",
                             (batch_id, key, expected, deadline))
            return {"batch_id": batch_id, "items": self.renewal_batch_rows(conn, batch_id)}, True

    def renewal_batch_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            items = self.renewal_batch_rows(conn, batch_id)
            if not items:
                raise Missing("Unknown renewal batch")
            return {"batch_id": batch_id, "items": items}

    def renewal_history(self, key, limit, before):
        through = 2**63 - 1 if before is None else before - 1
        with self.current_inventory() as (conn, _):
            reservation = self.progress_row(self.find_reservation(conn, key))
            rows = [dict(row) for row in conn.execute("""
                SELECT 'single' AS source, renewal_id AS receipt_id, previous_expires_at_ms, expires_at_ms
                FROM reservation_renewals WHERE reservation_id=? AND expires_at_ms<=?
                UNION ALL
                SELECT 'batch', batch_id, previous_expires_at_ms, expires_at_ms
                FROM reservation_renewal_batches WHERE reservation_id=? AND expires_at_ms<=?
                ORDER BY expires_at_ms DESC LIMIT ?
            """, (key, through, key, through, limit + 1))]
            page = rows[:limit]
            return {"reservation": reservation, "renewals": page,
                    "next_before_expires_at_ms": page[-1]["expires_at_ms"] if len(rows) > limit else None}

    def release(self, key):
        with self.current_inventory() as (conn, _):
            row = self.find_reservation(conn, key)
            if self.release_remaining(conn, row) is not None:
                return self.reservation(row) | {"state": "released"}
            return self.reservation(row)

    def release_remaining(self, conn, row):
        if row["state"] != "held":
            return None
        quantity = self.held_units(row)
        conn.execute("UPDATE products SET available=available+? WHERE sku=?", (quantity, row["sku"]))
        conn.execute("UPDATE reservations SET state='released' WHERE id=?", (row["id"],))
        return quantity

    @staticmethod
    def held_units(row):
        return row["quantity"] - row["shipped"] - row["reduced"] if row["state"] == "held" else 0

    def release_units(self, key, release_id, quantity):
        with self.current_inventory() as (conn, now):
            row = self.find_reservation(conn, key)
            receipt = conn.execute("""SELECT reservation_id,release_id,quantity,held_after FROM reservation_releases
                                      WHERE reservation_id=? AND release_id=?""", (key, release_id)).fetchone()
            if receipt:
                if receipt["quantity"] != quantity:
                    raise Conflict("Release key already used with different quantity")
                return dict(receipt), False
            return self.record_release(conn, row, release_id, quantity, now), True

    def record_release(self, conn, row, release_id, quantity, released_at_ms=None):
        key = row["id"]
        held_after = self.held_units(row) - quantity
        if held_after < 0:
            raise Conflict("Release exceeds the remaining hold")
        conn.execute("UPDATE products SET available=available+? WHERE sku=?", (quantity, row["sku"]))
        conn.execute("UPDATE reservations SET reduced=reduced+?, state=? WHERE id=?",
                     (quantity, "held" if held_after else "released", key))
        conn.execute("""INSERT INTO reservation_releases
                        (reservation_id,release_id,quantity,held_after,released_at_ms) VALUES (?,?,?,?,?)""",
                     (key, release_id, quantity, held_after, released_at_ms))
        return {"reservation_id": key, "release_id": release_id, "quantity": quantity, "held_after": held_after}

    @staticmethod
    def recorded_release_batch(conn, batch_id):
        rows = [dict(row) for row in conn.execute("""
            SELECT r.reservation_id,b.released_at_ms,r.quantity+r.held_after AS held_before,r.quantity,r.held_after
            FROM reservation_release_batches b JOIN reservation_releases r USING (reservation_id, release_id)
            WHERE b.batch_id=? ORDER BY r.reservation_id
        """, (batch_id,))]
        if not rows:
            return None
        released_at = rows[0]["released_at_ms"]
        for row in rows:
            del row["released_at_ms"]
        return {"batch_id": batch_id, "released_at_ms": released_at, "items": rows}

    def release_batch(self, batch_id, items):
        requested = sorted(items)
        # Batch receipts share the per-reservation release ledger used by inventory reconciliation.
        # Single-release request keys cannot contain a colon.
        release_id = f"batch:{batch_id}"
        with self.current_inventory() as (conn, now):
            receipt = self.recorded_release_batch(conn, batch_id)
            if receipt:
                saved = [(item["reservation_id"], item["held_before"], item["quantity"]) for item in receipt["items"]]
                if saved != requested:
                    raise Conflict("Release batch key already used with different input")
                return receipt, False
            for key, expected, quantity in requested:
                try:
                    row = self.find_reservation(conn, key)
                    if self.held_units(row) != expected:
                        raise Conflict("Remaining hold changed")
                    self.record_release(conn, row, release_id, quantity)
                except (Missing, Conflict) as error:
                    raise type(error)(f"{key}: {error}") from error
                conn.execute("INSERT INTO reservation_release_batches VALUES (?,?,?,?)",
                             (batch_id, key, release_id, now))
            return self.recorded_release_batch(conn, batch_id), True

    def release_batch_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            receipt = self.recorded_release_batch(conn, batch_id)
            if receipt is None:
                raise Missing("Unknown release batch")
            return receipt

    def release_history(self, key, limit, after_held):
        with self.current_inventory() as (conn, now):
            reservation = self.progress_row(self.find_reservation(conn, key))
            # Releases and shipments only decrease a hold, so each release leaves a distinct quantity.
            rows = [dict(row) for row in conn.execute("""
                SELECT CASE WHEN b.batch_id IS NULL THEN 'single' ELSE 'batch' END AS source,
                       COALESCE(b.batch_id,r.release_id) AS receipt_id,
                       COALESCE(b.released_at_ms,r.released_at_ms) AS released_at_ms,
                       r.held_after+r.quantity AS held_before,r.quantity,r.held_after
                FROM reservation_releases r LEFT JOIN reservation_release_batches b
                  USING (reservation_id, release_id)
                WHERE r.reservation_id=? AND r.held_after>? ORDER BY r.held_after LIMIT ?
            """, (key, -1 if after_held is None else after_held, limit + 1))]
            page = rows[:limit]
            return {"captured_at_ms": now, "reservation": reservation, "releases": page,
                    "next_after_held": page[-1]["held_after"] if len(rows) > limit else None}

    def progress_row(self, row):
        outstanding = row["quantity"] - row["shipped"]
        held = self.held_units(row)
        return self.reservation(row) | {"shipped": row["shipped"], "held": held,
                                        "returned": outstanding - held}

    def progress(self, key):
        with self.current_inventory() as (conn, _):
            return self.progress_row(self.find_reservation(conn, key))

    def fulfill(self, key, shipment_id, quantity):
        with self.current_inventory() as (conn, _):
            return self.record_shipment(conn, key, shipment_id, quantity)

    @staticmethod
    def shipment_receipt(conn, key, shipment_id):
        return conn.execute("""SELECT * FROM fulfillments
                                  WHERE reservation_id=? AND shipment_id=?""", (key, shipment_id)).fetchone()

    def record_shipment(self, conn, key, shipment_id, quantity):
        row = self.find_reservation(conn, key)
        receipt = self.shipment_receipt(conn, key, shipment_id)
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
    def batch_receipts(conn, batch_id):
        rows = conn.execute("""SELECT f.* FROM dispatch_batch_boxes b JOIN fulfillments f
                               USING (reservation_id, shipment_id) WHERE b.batch_id=?
                               ORDER BY b.reservation_id, b.shipment_id""", (batch_id,))
        return [dict(row) for row in rows]

    def dispatch_preview(self, boxes):
        with self.current_inventory() as (conn, now):
            results = []
            for key, entries in groupby(sorted(boxes), key=lambda box: box[0]):
                row = conn.execute("SELECT * FROM reservations WHERE id=?", (key,)).fetchone()
                held = self.held_units(row) if row is not None else None
                sku = row["sku"] if row is not None else None
                state = self.reservation(row)["state"] if row is not None else None
                for _, shipment_id, quantity in entries:
                    before = held
                    after = shortfall = None
                    if before is None:
                        status = "unknown_reservation"
                    elif self.shipment_receipt(conn, key, shipment_id) is not None:
                        status = "already_shipped"
                    elif quantity > before:
                        status, shortfall = "insufficient_held", quantity - before
                    else:
                        status = "ready"
                        held = after = before - quantity
                    results.append({
                        "reservation_id": key, "shipment_id": shipment_id, "quantity": quantity,
                        "sku": sku, "reservation_state": state, "held_before": before,
                        "held_after": after, "shortfall": shortfall, "status": status,
                    })
            return {"captured_at_ms": now, "can_dispatch": all(x["status"] == "ready" for x in results),
                    "boxes": results}

    def dispatch_batch(self, batch_id, boxes):
        ordered = sorted(boxes)
        with self.current_inventory() as (conn, _):
            receipts = self.batch_receipts(conn, batch_id)
            if receipts:
                prior = [(r["reservation_id"], r["shipment_id"], r["quantity"]) for r in receipts]
                if prior != ordered:
                    raise Conflict("Dispatch batch key already used with different boxes")
                return {"batch_id": batch_id, "boxes": receipts}, False
            for key, shipment_id, quantity in ordered:
                try:
                    receipt, created = self.record_shipment(conn, key, shipment_id, quantity)
                except (Missing, Conflict) as exc:
                    raise type(exc)(f"{key}/{shipment_id}: {exc}") from exc
                if not created:
                    raise Conflict(f"Shipment already recorded: {key}/{shipment_id}")
                conn.execute("INSERT INTO dispatch_batch_boxes VALUES (?,?,?)", (batch_id, key, shipment_id))
                receipts.append(receipt)
            return {"batch_id": batch_id, "boxes": receipts}, True

    def dispatch_batch_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            boxes = self.batch_receipts(conn, batch_id)
            if not boxes:
                raise Missing("Unknown dispatch batch")
            return {"batch_id": batch_id, "boxes": boxes}

    @staticmethod
    def shipment_balances(conn, keys, shipment_id=None):
        query = """
            SELECT f.reservation_id, f.shipment_id, f.quantity AS dispatched, r.sku,
                   COALESCE((SELECT SUM(sr.quantity) FROM shipment_returns sr
                             WHERE sr.reservation_id=f.reservation_id AND sr.shipment_id=f.shipment_id), 0)
                       AS restocked
            FROM fulfillments f JOIN reservations r ON r.id=f.reservation_id
        """
        query += " WHERE f.reservation_id IN (" + ",".join("?" for _ in keys) + ")"
        parameters = list(keys)
        if shipment_id is not None:
            query += " AND f.shipment_id=?"
            parameters.append(shipment_id)
        for row in conn.execute(query + " ORDER BY f.reservation_id, f.shipment_id", parameters):
            yield dict(row) | {"returnable": row["dispatched"] - row["restocked"]}

    def shipment_balance(self, conn, key, shipment_id):
        balance = next(self.shipment_balances(conn, (key,), shipment_id), None)
        if balance is None:
            raise Missing("Unknown shipment")
        return balance

    def packing_statement(self, key):
        with self.current_inventory() as (conn, _):
            reservation = self.find_reservation(conn, key)
            boxes = list(self.shipment_balances(conn, (key,)))
            return self.packing_row(reservation, boxes)

    def packing_row(self, reservation, boxes):
        return {"reservation": self.progress_row(reservation), "boxes": boxes,
                "restocked": sum(box["restocked"] for box in boxes),
                "returnable": sum(box["returnable"] for box in boxes)}

    @staticmethod
    def products_for(conn, skus):
        skus = sorted(set(skus))
        placeholders = ",".join("?" for _ in skus)
        return [dict(row) for row in conn.execute(
            f"SELECT * FROM products WHERE sku IN ({placeholders}) ORDER BY sku", skus)]

    def packing_snapshot(self, keys):
        placeholders = ",".join("?" for _ in keys)
        with self.current_inventory() as (conn, now):
            reservations = {row["id"]: row for row in conn.execute(
                f"SELECT * FROM reservations WHERE id IN ({placeholders})", keys)}
            missing = [key for key in keys if key not in reservations]
            if missing:
                raise Missing("Unknown reservations: " + ", ".join(missing))
            boxes = {key: [] for key in keys}
            for row in self.shipment_balances(conn, keys):
                boxes[row["reservation_id"]].append(row)
            return {
                "captured_at_ms": now,
                "holds": [self.packing_row(reservations[key], boxes[key]) for key in keys],
                "products": self.products_for(conn, (row["sku"] for row in reservations.values())),
            }

    def shipment(self, key, shipment_id):
        with closing(self.connect()) as conn:
            return self.shipment_balance(conn, key, shipment_id)

    def dispatch_manifest(self, key):
        with self.current_inventory() as (conn, _):
            row = self.find_reservation(conn, key)
            if self.held_units(row) or not row["shipped"]:
                raise Conflict("Dispatch manifest requires a closed reservation with shipped units")
            return conn.execute("""SELECT shipment_id, quantity FROM fulfillments
                                   WHERE reservation_id=? ORDER BY shipment_id""", (key,)).fetchall()

    def restock(self, key, shipment_id, return_id, quantity):
        with self.current_inventory() as (conn, _):
            return self.record_return(conn, key, shipment_id, return_id, quantity)

    def record_return(self, conn, key, shipment_id, return_id, quantity):
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
        updated = conn.execute("""UPDATE products SET capacity=capacity+?, available=available+?
                                  WHERE sku=? AND capacity<=?""",
                               (quantity, quantity, balance["sku"], 2**63 - 1 - quantity))
        if not updated.rowcount:
            raise Conflict("Capacity exceeds SQLite integer range")
        conn.execute("""INSERT INTO shipment_returns(reservation_id, shipment_id, return_id, quantity,
                                                     returnable_after) VALUES (?, ?, ?, ?, ?)""",
                     (*ids, quantity, remaining))
        return {"reservation_id": key, "shipment_id": shipment_id, "return_id": return_id,
                "quantity": quantity, "returnable_after": remaining}, True

    @staticmethod
    def return_batch_rows(conn, batch_id):
        rows = conn.execute("""SELECT r.* FROM return_batch_boxes b JOIN shipment_returns r
                               ON r.reservation_id=b.reservation_id AND r.shipment_id=b.shipment_id
                               AND r.return_id=b.batch_id WHERE b.batch_id=?
                               ORDER BY b.reservation_id, b.shipment_id""", (batch_id,))
        return [dict(row) for row in rows]

    def return_batch(self, batch_id, boxes):
        ordered = sorted(boxes)
        with self.current_inventory() as (conn, _):
            receipts = self.return_batch_rows(conn, batch_id)
            if receipts:
                prior = [(r["reservation_id"], r["shipment_id"], r["quantity"]) for r in receipts]
                if prior != ordered:
                    raise Conflict("Return batch key already used with different boxes")
                return {"batch_id": batch_id, "boxes": receipts}, False
            for key, shipment_id, quantity in ordered:
                try:
                    receipt, created = self.record_return(conn, key, shipment_id, batch_id, quantity)
                    if not created:
                        raise Conflict("Return already recorded separately")
                except (Missing, Conflict) as exc:
                    raise type(exc)(f"{key}/{shipment_id}: {exc}") from exc
                conn.execute("INSERT INTO return_batch_boxes VALUES (?,?,?)", (batch_id, key, shipment_id))
                receipts.append(receipt)
            return {"batch_id": batch_id, "boxes": receipts}, True

    def return_batch_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            boxes = self.return_batch_rows(conn, batch_id)
            if not boxes:
                raise Missing("Unknown return batch")
            return {"batch_id": batch_id, "boxes": boxes}
