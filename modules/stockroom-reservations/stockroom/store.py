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
CREATE TABLE IF NOT EXISTS inventory_revisions (
    sku TEXT PRIMARY KEY REFERENCES products(sku),
    revision INTEGER NOT NULL CHECK (typeof(revision)='integer' AND revision>0)
);
CREATE TRIGGER IF NOT EXISTS track_inventory_capacity
AFTER UPDATE OF capacity ON products WHEN NEW.capacity<>OLD.capacity
BEGIN
    INSERT INTO inventory_revisions(sku,revision) VALUES (NEW.sku,1)
    ON CONFLICT(sku) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE IF NOT EXISTS stock_count_adjustments (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    count_session TEXT NOT NULL,
    reason TEXT NOT NULL,
    recorded_at_ms INTEGER NOT NULL,
    previous_revision INTEGER NOT NULL CHECK (previous_revision>=0),
    previous_capacity INTEGER NOT NULL,
    previous_available INTEGER NOT NULL CHECK (previous_available BETWEEN 0 AND previous_capacity),
    counted INTEGER NOT NULL,
    available INTEGER NOT NULL CHECK (available BETWEEN 0 AND counted),
    revision INTEGER NOT NULL,
    CHECK (counted - available = previous_capacity - previous_available),
    CHECK (revision = previous_revision + (counted <> previous_capacity))
);
CREATE TABLE IF NOT EXISTS stock_count_batch_items (
    batch_id TEXT NOT NULL,
    adjustment_id TEXT NOT NULL UNIQUE REFERENCES stock_count_adjustments(id),
    PRIMARY KEY (batch_id, adjustment_id)
);
CREATE TABLE IF NOT EXISTS stock_count_batch_reversals (
    source_batch_id TEXT PRIMARY KEY,
    reversal_batch_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    CHECK (source_batch_id<>reversal_batch_id)
);
CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL REFERENCES products(sku),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    state TEXT NOT NULL CHECK (state IN ('held', 'released'))
);
CREATE INDEX IF NOT EXISTS active_allocations_by_sku ON reservations(sku, id) WHERE state='held';
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
CREATE TABLE IF NOT EXISTS return_inspection_boxes (
    reservation_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    sellable INTEGER NOT NULL CHECK (sellable >= 0),
    quarantined INTEGER NOT NULL CHECK (quarantined >= 0),
    returnable_after INTEGER NOT NULL CHECK (returnable_after >= 0),
    received_at_ms INTEGER CHECK (received_at_ms >= 0),
    CHECK (sellable + quarantined BETWEEN 1 AND 1000000),
    PRIMARY KEY (reservation_id, shipment_id, batch_id),
    FOREIGN KEY (reservation_id, shipment_id) REFERENCES fulfillments(reservation_id, shipment_id)
);
CREATE INDEX IF NOT EXISTS return_inspection_by_batch
    ON return_inspection_boxes(batch_id, reservation_id, shipment_id);
CREATE TABLE IF NOT EXISTS return_quarantine_dispositions (
    batch_id TEXT NOT NULL,
    disposition_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL,
    restock INTEGER NOT NULL CHECK (restock >= 0),
    discard INTEGER NOT NULL CHECK (discard >= 0),
    remaining_after INTEGER NOT NULL CHECK (remaining_after >= 0),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
    recorded_at_ms INTEGER NOT NULL,
    CHECK (restock + discard BETWEEN 1 AND 1000000),
    PRIMARY KEY (batch_id, disposition_id, reservation_id, shipment_id),
    FOREIGN KEY (reservation_id, shipment_id, batch_id)
        REFERENCES return_inspection_boxes(reservation_id, shipment_id, batch_id)
);
CREATE INDEX IF NOT EXISTS quarantine_disposition_by_shipment
    ON return_quarantine_dispositions(reservation_id, shipment_id, batch_id);
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
            if "reclaimed_at_ms" not in columns:
                conn.execute("ALTER TABLE reservations ADD COLUMN reclaimed_at_ms INTEGER")
            release_columns = {row["name"] for row in conn.execute("PRAGMA table_info(reservation_releases)")}
            if "released_at_ms" not in release_columns:
                conn.execute("ALTER TABLE reservation_releases ADD COLUMN released_at_ms INTEGER")
            inspection_columns = {row["name"] for row in conn.execute("PRAGMA table_info(return_inspection_boxes)")}
            if "received_at_ms" not in inspection_columns:
                conn.execute("ALTER TABLE return_inspection_boxes ADD COLUMN received_at_ms INTEGER CHECK (received_at_ms >= 0)")
            conn.execute("""CREATE INDEX IF NOT EXISTS active_deadlines ON reservations(expires_at_ms)
                            WHERE state='held' AND expires_at_ms IS NOT NULL""")
            conn.execute("""CREATE INDEX IF NOT EXISTS expiry_history_deadlines ON reservations(expires_at_ms, id)
                            WHERE timed_out=1""")
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
            conn.execute("""UPDATE reservations SET state='released', timed_out=1, reclaimed_at_ms=?
                            WHERE state='held' AND expires_at_ms<=?""", (now, now))
            yield conn, now

    @staticmethod
    def reservation(row):
        result = dict(row)
        shipped = result.pop("shipped")
        result.pop("reduced")
        result.pop("reclaimed_at_ms")
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

    @staticmethod
    def stock_count_product(conn, sku):
        row = conn.execute("""SELECT products.*, COALESCE(inventory_revisions.revision,0) AS revision
                              FROM products LEFT JOIN inventory_revisions USING(sku)
                              WHERE products.sku=?""", (sku,)).fetchone()
        if row is None:
            raise Missing("Unknown SKU")
        return dict(row)

    def stock_count_basis(self, sku):
        with self.current_inventory() as (conn, now):
            return {**self.count_basis_row(conn, sku), "captured_at_ms": now}

    def count_basis_row(self, conn, sku):
        row = self.stock_count_product(conn, sku)
        return {**row, "held": row["capacity"] - row["available"]}

    def stock_count_bases(self, skus):
        with self.current_inventory() as (conn, now):
            return {"captured_at_ms": now, "products": [self.count_basis_row(conn, sku) for sku in sorted(skus)]}

    def sku_allocations(self, sku, limit, after_id):
        with self.current_inventory() as (conn, now):
            product = self.stock_count_product(conn, sku)
            scope = "r.sku=? AND r.state='held' AND r.quantity>r.shipped+r.reduced"
            summary = conn.execute(f"""SELECT COUNT(*) AS reservation_count,
                COALESCE(SUM(r.quantity-r.shipped-r.reduced), 0) AS held,
                COUNT(*) FILTER (WHERE r.expires_at_ms IS NULL) AS without_deadline_count,
                COALESCE(SUM(r.quantity-r.shipped-r.reduced) FILTER (WHERE r.expires_at_ms IS NULL), 0)
                    AS without_deadline_held,
                MIN(r.expires_at_ms) AS next_expiry_at_ms
                FROM reservations r WHERE {scope}""", (sku,)).fetchone()
            cursor = "" if after_id is None else "AND r.id>?"
            args = (sku,) if after_id is None else (sku, after_id)
            rows = conn.execute(f"""SELECT r.id AS reservation_id, b.batch_id, r.expires_at_ms,
                    r.quantity, r.shipped, r.reduced AS released, r.quantity-r.shipped-r.reduced AS held
                FROM reservations r LEFT JOIN reservation_batch_items b ON b.reservation_id=r.id
                WHERE {scope} {cursor} ORDER BY r.id LIMIT ?""", (*args, limit + 1)).fetchall()
            return {"captured_at_ms": now, "product": product, "summary": dict(summary),
                    "reservations": [dict(row) for row in rows[:limit]],
                    "next_after_id": rows[limit - 1]["reservation_id"] if len(rows) > limit else None}

    @staticmethod
    def stock_count_row(conn, key):
        return conn.execute("SELECT * FROM stock_count_adjustments WHERE id=?", (key,)).fetchone()

    def adjust_stock_count(self, sku, key, expected_revision, counted, count_session, reason):
        with self.current_inventory() as (conn, now):
            prior = self.stock_count_row(conn, key)
            if prior is not None:
                original = tuple(prior[name] for name in ("sku", "previous_revision", "counted", "count_session", "reason"))
                if original != (sku, expected_revision, counted, count_session, reason):
                    raise Conflict("Adjustment key already used with different input")
                return dict(prior), False
            return self.record_stock_count(conn, now, key, sku, expected_revision, counted, count_session, reason), True

    def record_stock_count(self, conn, now, key, sku, expected_revision, counted, count_session, reason):
        product = self.count_basis_row(conn, sku)
        if product["revision"] != expected_revision:
            raise Conflict("Physical stock changed since the count basis")
        if counted < product["held"]:
            raise Conflict("Count is below the units still reserved")
        available = counted - product["held"]
        conn.execute("UPDATE products SET capacity=?, available=? WHERE sku=?", (counted, available, sku))
        revision = self.stock_count_product(conn, sku)["revision"]
        conn.execute("""INSERT INTO stock_count_adjustments
            (id,sku,count_session,reason,recorded_at_ms,previous_revision,previous_capacity,previous_available,counted,available,revision)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                     (key, sku, count_session, reason, now, expected_revision, product["capacity"], product["available"],
                      counted, available, revision))
        return dict(self.stock_count_row(conn, key))

    def stock_count_adjustment(self, sku, key):
        with closing(self.connect()) as conn:
            row = self.stock_count_row(conn, key)
            if row is None or row["sku"] != sku:
                raise Missing("Unknown stock count adjustment")
            return dict(row)

    @staticmethod
    def stock_count_batch_rows(conn, batch_id):
        return [dict(row) for row in conn.execute("""
            SELECT a.* FROM stock_count_batch_items AS b
            JOIN stock_count_adjustments AS a ON a.id=b.adjustment_id
            WHERE b.batch_id=? ORDER BY a.sku
        """, (batch_id,))]

    def adjust_stock_count_batch(self, batch_id, items, count_session, reason):
        ordered = sorted(items)
        with self.current_inventory() as (conn, now):
            receipts = self.stock_count_batch_rows(conn, batch_id)
            if receipts:
                prior = [(r["sku"], r["previous_revision"], r["counted"]) for r in receipts]
                if prior != ordered or (receipts[0]["count_session"], receipts[0]["reason"]) != (count_session, reason):
                    raise Conflict("Stock count batch key already used with different input")
                return {"batch_id": batch_id, "items": receipts}, False
            return self.record_stock_count_batch(conn, now, batch_id, ordered, count_session, reason), True

    def record_stock_count_batch(self, conn, now, batch_id, ordered, count_session, reason):
        receipts = []
        for sku, revision, counted in ordered:
            key = uuid4().hex
            try:
                receipt = self.record_stock_count(conn, now, key, sku, revision, counted, count_session, reason)
            except (Missing, Conflict) as error:
                raise type(error)(f"{sku}: {error}") from error
            conn.execute("INSERT INTO stock_count_batch_items VALUES (?, ?)", (batch_id, key))
            receipts.append(receipt)
        return {"batch_id": batch_id, "items": receipts}

    def stock_count_batch(self, batch_id):
        with closing(self.connect()) as conn:
            receipts = self.stock_count_batch_rows(conn, batch_id)
            if not receipts:
                raise Missing("Unknown stock count batch")
            return {"batch_id": batch_id, "items": receipts}

    def stock_count_batch_reversal_record(self, conn, batch_id):
        link = conn.execute("""SELECT reversal_batch_id,request_id FROM stock_count_batch_reversals
                               WHERE source_batch_id=?""", (batch_id,)).fetchone()
        if link is None:
            return None, None
        reversal = link["reversal_batch_id"]
        return {"source_batch_id": batch_id, "batch_id": reversal,
                "items": self.stock_count_batch_rows(conn, reversal)}, link["request_id"]

    def reverse_stock_count_batch(self, batch_id, request_id, reason):
        with self.current_inventory() as (conn, now):
            previous, operation = self.stock_count_batch_reversal_record(conn, batch_id)
            if previous is not None:
                if request_id != operation or previous["items"][0]["reason"] != reason:
                    raise Conflict("Stock count batch has already been reversed")
                return previous, False
            original = self.stock_count_batch_rows(conn, batch_id)
            if not original:
                raise Missing("Unknown stock count batch")
            ordered = [(line["sku"], line["revision"], line["previous_capacity"]) for line in original]
            reversal_id = uuid4().hex
            if self.stock_count_batch_rows(conn, reversal_id):
                raise Conflict("Reversal batch ID already exists; retry the request")
            receipt = self.record_stock_count_batch(conn, now, reversal_id, ordered, original[0]["count_session"], reason)
            conn.execute("INSERT INTO stock_count_batch_reversals VALUES (?, ?, ?)", (batch_id, reversal_id, request_id))
            return {"source_batch_id": batch_id, **receipt}, True

    def stock_count_batch_reversal(self, batch_id):
        with closing(self.connect()) as conn:
            receipt, _ = self.stock_count_batch_reversal_record(conn, batch_id)
            if receipt is None:
                raise Missing("Unknown stock count batch reversal")
            return receipt

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

    def expiry_history(self, since_ms, through_ms, sku, before, limit):
        with self.current_inventory() as (conn, now):
            through = now if through_ms is None else through_ms
            if not since_ms <= through <= now:
                raise ValueError("Invalid expiry history interval")
            rows = conn.execute("""SELECT r.id AS reservation_id, r.sku, b.batch_id, r.expires_at_ms,
                                    r.reclaimed_at_ms, r.quantity, r.shipped, r.reduced AS released_before_expiry,
                                    r.quantity - r.shipped - r.reduced AS reclaimed
                                    FROM reservations r
                                    LEFT JOIN reservation_batch_items b ON b.reservation_id=r.id
                                    WHERE r.timed_out=1 AND r.expires_at_ms BETWEEN ? AND ?
                                    AND (r.reclaimed_at_ms IS NULL OR r.reclaimed_at_ms<=?)
                                    AND (? IS NULL OR r.sku=?)
                                    AND (? IS NULL OR (r.expires_at_ms, r.id) < (?,?))
                                    ORDER BY r.expires_at_ms DESC, r.id DESC LIMIT ?""",
                                (since_ms, through, through, sku, sku, before[0], *before, limit + 1)).fetchall()
            items = [dict(row) for row in rows[:limit]]
            next_page = None
            if len(rows) > limit:
                last = items[-1]
                next_page = {"through_ms": through, "before_expires_at_ms": last["expires_at_ms"],
                             "before_id": last["reservation_id"]}
            return {"captured_at_ms": now, "since_ms": since_ms, "through_ms": through,
                    "reservations": items, "next": next_page}

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

    def dispatch_batch(self, batch_id, boxes, *, window=None):
        ordered = sorted(boxes)
        with self.current_inventory() as (conn, now):
            receipts = self.batch_receipts(conn, batch_id)
            if receipts:
                prior = [(r["reservation_id"], r["shipment_id"], r["quantity"]) for r in receipts]
                if prior != ordered:
                    raise Conflict("Dispatch batch key already used with different boxes")
                return {"batch_id": batch_id, "boxes": receipts}, False
            if window is not None and not window[0] <= now < window[1]:
                raise Conflict("Outside the scheduled dispatch window")
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
                       + COALESCE((SELECT SUM(i.sellable) FROM return_inspection_boxes i
                                   WHERE i.reservation_id=f.reservation_id AND i.shipment_id=f.shipment_id), 0)
                       AS restocked,
                   COALESCE((SELECT SUM(i.quarantined) FROM return_inspection_boxes i
                             WHERE i.reservation_id=f.reservation_id AND i.shipment_id=f.shipment_id), 0)
                       AS received_in_quarantine,
                   COALESCE((SELECT SUM(d.restock) FROM return_quarantine_dispositions d
                             WHERE d.reservation_id=f.reservation_id AND d.shipment_id=f.shipment_id), 0) AS restored,
                   COALESCE((SELECT SUM(d.discard) FROM return_quarantine_dispositions d
                             WHERE d.reservation_id=f.reservation_id AND d.shipment_id=f.shipment_id), 0) AS discarded
            FROM fulfillments f JOIN reservations r ON r.id=f.reservation_id
        """
        query += " WHERE f.reservation_id IN (" + ",".join("?" for _ in keys) + ")"
        parameters = list(keys)
        if shipment_id is not None:
            query += " AND f.shipment_id=?"
            parameters.append(shipment_id)
        for row in conn.execute(query + " ORDER BY f.reservation_id, f.shipment_id", parameters):
            box = dict(row)
            restored, discarded = box.pop("restored"), box.pop("discarded")
            received = box.pop("received_in_quarantine")
            quarantined = received - restored - discarded
            box["restocked"] += restored
            if quarantined:
                box["quarantined"] = quarantined
            if discarded:
                box["discarded"] = discarded
            yield box | {"returnable": row["dispatched"] - row["restocked"] - received}

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
        report = {"reservation": self.progress_row(reservation), "boxes": boxes,
                  "restocked": sum(box["restocked"] for box in boxes),
                  "returnable": sum(box["returnable"] for box in boxes)}
        for field in ("quarantined", "discarded"):
            units = sum(box.get(field, 0) for box in boxes)
            if units:
                report[field] = units
        return report

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
        self.restock_product(conn, balance["sku"], quantity)
        conn.execute("""INSERT INTO shipment_returns(reservation_id, shipment_id, return_id, quantity,
                                                     returnable_after) VALUES (?, ?, ?, ?, ?)""",
                     (*ids, quantity, remaining))
        return {"reservation_id": key, "shipment_id": shipment_id, "return_id": return_id,
                "quantity": quantity, "returnable_after": remaining}, True

    @staticmethod
    def restock_product(conn, sku, quantity):
        updated = conn.execute("""UPDATE products SET capacity=capacity+?, available=available+?
                                  WHERE sku=? AND capacity<=?""",
                               (quantity, quantity, sku, 2**63 - 1 - quantity))
        if not updated.rowcount:
            raise Conflict("Capacity exceeds SQLite integer range")

    @staticmethod
    def return_inspection_rows(conn, batch_id):
        rows = conn.execute("""SELECT reservation_id,shipment_id,sellable,quarantined,returnable_after
                               FROM return_inspection_boxes WHERE batch_id=?
                               ORDER BY reservation_id,shipment_id""", (batch_id,))
        return [dict(row) for row in rows]

    def preview_return_inspection(self, boxes):
        reviewed = []
        with closing(self.connect()) as conn:
            conn.execute("BEGIN")
            for box in boxes:
                try:
                    balance = self.shipment_balance(conn, box["reservation_id"], box["shipment_id"])
                except Missing:
                    reviewed.append(dict(box, status="unknown_shipment", sku=None, dispatched=None, returnable=None))
                    continue
                remaining = balance["returnable"] - box["sellable"] - box["quarantined"]
                status = "ready"
                if box["label_quantity"] != balance["dispatched"]:
                    status = "label_mismatch"
                elif remaining < 0:
                    status = "insufficient_returnable"
                reviewed.append(dict(box, status=status, sku=balance["sku"], dispatched=balance["dispatched"],
                                     returnable=balance["returnable"]))
        return {"can_receive": all(box["status"] == "ready" for box in reviewed), "boxes": reviewed}

    def return_inspection(self, batch_id, boxes):
        ordered = sorted(boxes)
        with self.current_inventory() as (conn, now):
            receipts = self.return_inspection_rows(conn, batch_id)
            if receipts:
                prior = [(r["reservation_id"], r["shipment_id"], r["sellable"], r["quarantined"]) for r in receipts]
                if prior != ordered:
                    raise Conflict("Inspection key already used with different boxes or conditions")
                return {"batch_id": batch_id, "boxes": receipts}, False
            for key, shipment, sellable, quarantined in ordered:
                try:
                    balance = self.shipment_balance(conn, key, shipment)
                    remaining = balance["returnable"] - sellable - quarantined
                    if remaining < 0:
                        raise Conflict("Inspection exceeds the units outstanding for this shipment")
                    if sellable:
                        self.restock_product(conn, balance["sku"], sellable)
                    conn.execute("""INSERT INTO return_inspection_boxes
                                    (reservation_id,shipment_id,batch_id,sellable,quarantined,returnable_after,received_at_ms)
                                    VALUES (?,?,?,?,?,?,?)""", (key, shipment, batch_id, sellable, quarantined, remaining, now))
                except (Missing, Conflict) as exc:
                    raise type(exc)(f"{key}/{shipment}: {exc}") from exc
                receipts.append({"reservation_id": key, "shipment_id": shipment, "sellable": sellable,
                                 "quarantined": quarantined, "returnable_after": remaining})
            return {"batch_id": batch_id, "boxes": receipts}, True

    def return_inspection_receipt(self, batch_id):
        with closing(self.connect()) as conn:
            boxes = self.return_inspection_rows(conn, batch_id)
            if not boxes:
                raise Missing("Unknown return inspection")
            return {"batch_id": batch_id, "boxes": boxes}

    quarantine_balance_sql = """SELECT i.batch_id,i.received_at_ms,i.reservation_id,i.shipment_id,r.sku,i.quarantined,
                COALESCE(SUM(d.restock),0) AS restocked,COALESCE(SUM(d.discard),0) AS discarded
            FROM return_inspection_boxes i JOIN reservations r ON r.id=i.reservation_id
            LEFT JOIN return_quarantine_dispositions d ON d.batch_id=i.batch_id
                AND d.reservation_id=i.reservation_id AND d.shipment_id=i.shipment_id
            WHERE i.quarantined>0"""

    def quarantine_balances(self, conn, batch_id):
        balances = []
        rows = conn.execute(f"""{self.quarantine_balance_sql} AND i.batch_id=?
            GROUP BY i.reservation_id,i.shipment_id,i.batch_id ORDER BY i.reservation_id,i.shipment_id""", (batch_id,))
        for row in rows:
            box = dict(row)
            box.pop("batch_id")
            box.pop("received_at_ms")
            balances.append(dict(box, remaining=box["quarantined"] - box["restocked"] - box["discarded"]))
        return balances

    def quarantine_queue(self, sku, limit, after):
        sku_filter = "" if sku is None else "AND r.sku=?"
        page_filter = "" if after is None else "WHERE (queue_time,batch_id)>(?,?)"
        parameters = (() if sku is None else (sku,)) + (() if after is None else after) + (limit + 1,)
        with closing(self.connect()) as conn:
            rows = conn.execute(f"""WITH box_totals AS (
                {self.quarantine_balance_sql} {sku_filter}
                GROUP BY i.reservation_id,i.shipment_id,i.batch_id
            ), open_batches AS (
                SELECT batch_id,MIN(COALESCE(received_at_ms,-1)) AS queue_time,
                       COUNT(*) AS pending_boxes,SUM(quarantined-restocked-discarded) AS pending_units
                FROM box_totals
                WHERE quarantined>restocked+discarded GROUP BY batch_id
            ), totals AS (
                SELECT COUNT(*) AS batches,COALESCE(SUM(pending_boxes),0) AS boxes,
                       COALESCE(SUM(pending_units),0) AS units FROM open_batches
            ), page AS (
                SELECT * FROM open_batches {page_filter} ORDER BY queue_time,batch_id LIMIT ?
            )
            SELECT page.*,totals.* FROM totals LEFT JOIN page ON TRUE
            ORDER BY page.queue_time,page.batch_id""", parameters).fetchall()
            captured_at_ms = int(self.clock() * 1000)
        first = rows[0]
        batches = [{"batch_id": row["batch_id"], "received_at_ms": None if row["queue_time"] == -1 else row["queue_time"],
                    "pending_boxes": row["pending_boxes"], "pending_units": row["pending_units"]}
                   for row in rows[:limit] if row["batch_id"] is not None]
        next_cursor = None
        if len(rows) > limit:
            tail = rows[limit - 1]
            next_cursor = {"after_received_at_ms": tail["queue_time"], "after_batch_id": tail["batch_id"]}
        return {"captured_at_ms": captured_at_ms, "sku": sku, "summary": {key: first[key] for key in ("batches", "boxes", "units")},
                "batches": batches, "next": next_cursor}

    def quarantine_status(self, batch_id):
        with closing(self.connect()) as conn:
            conn.execute("BEGIN")
            if not conn.execute("SELECT 1 FROM return_inspection_boxes WHERE batch_id=?", (batch_id,)).fetchone():
                raise Missing("Unknown return inspection")
            return {"batch_id": batch_id, "boxes": self.quarantine_balances(conn, batch_id)}

    @staticmethod
    def quarantine_receipt_rows(conn, batch_id, disposition_id):
        rows = conn.execute("""SELECT reservation_id,shipment_id,restock,discard,reason,remaining_after,recorded_at_ms
            FROM return_quarantine_dispositions WHERE batch_id=? AND disposition_id=? ORDER BY reservation_id,shipment_id""",
                            (batch_id, disposition_id))
        return [dict(row) for row in rows]

    def dispose_quarantine(self, batch_id, disposition_id, boxes):
        ordered = sorted(boxes)
        with self.current_inventory() as (conn, now):
            receipts = self.quarantine_receipt_rows(conn, batch_id, disposition_id)
            if receipts:
                prior = [(row["reservation_id"], row["shipment_id"], row["restock"], row["discard"],
                          row["restock"] + row["discard"] + row["remaining_after"], row["reason"]) for row in receipts]
                if prior != ordered:
                    raise Conflict("Disposition key already used with a different review")
                return {"batch_id": batch_id, "disposition_id": disposition_id, "boxes": receipts}, False
            balances = {(row["reservation_id"], row["shipment_id"]): row for row in self.quarantine_balances(conn, batch_id)}
            for reservation, shipment, restock, discard, expected, reason in ordered:
                balance = balances.get((reservation, shipment))
                if not balance:
                    raise Missing(f"{reservation}/{shipment}: no quarantined units in this inspection")
                if balance["remaining"] != expected or restock + discard > expected:
                    raise Conflict(f"{reservation}/{shipment}: quarantine balance changed or is insufficient")
                if restock:
                    self.restock_product(conn, balance["sku"], restock)
                remaining = expected - restock - discard
                conn.execute("""INSERT INTO return_quarantine_dispositions
                    (batch_id,disposition_id,reservation_id,shipment_id,restock,discard,reason,remaining_after,recorded_at_ms)
                    VALUES (?,?,?,?,?,?,?,?,?)""",
                             (batch_id, disposition_id, reservation, shipment, restock, discard, reason, remaining, now))
                receipts.append({"reservation_id": reservation, "shipment_id": shipment, "restock": restock,
                                 "discard": discard, "reason": reason, "remaining_after": remaining, "recorded_at_ms": now})
            return {"batch_id": batch_id, "disposition_id": disposition_id, "boxes": receipts}, True

    def quarantine_receipt(self, batch_id, disposition_id):
        with closing(self.connect()) as conn:
            boxes = self.quarantine_receipt_rows(conn, batch_id, disposition_id)
            if not boxes:
                raise Missing("Unknown quarantine disposition")
            return {"batch_id": batch_id, "disposition_id": disposition_id, "boxes": boxes}

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
