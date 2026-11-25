from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from threading import Event

from fastapi.testclient import TestClient

from sku_allocation_demo import capture
from stockroom.api import create_app
from stockroom.store import Store


URL = "/inventory/KIT-01/allocations"


def hold(api, key, quantity):
    return api.post("/reservations", headers={"Idempotency-Key": key},
                    json={"sku": "KIT-01", "quantity": quantity}).raise_for_status().json()


def test_report_pages_live_allocations_by_id_across_legacy_and_renewed_holds(tmp_path):
    path = tmp_path / "legacy.db"
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER NOT NULL, available INTEGER NOT NULL);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT NOT NULL, quantity INTEGER NOT NULL,
                                      state TEXT NOT NULL);
            INSERT INTO products VALUES ('KIT-01', 20, 17), ('OTHER', 5, 4), ('EMPTY', 5, 5);
            INSERT INTO reservations VALUES ('b-legacy','KIT-01',3,'held'), ('other','OTHER',1,'held');
        """)
    now = 100
    with TestClient(create_app(path, ttl_seconds=10, clock=lambda: now)) as api:
        hold(api, "d-timeout", 1)
        now = 105
        a = hold(api, "a-renew", 3)
        batch = api.post("/reservation-batches", headers={"Idempotency-Key": "z-batch"},
                         json={"items": [{"sku": "KIT-01", "quantity": 4}]}).raise_for_status().json()
        batch_key = batch["items"][0]["id"]
        api.post(f"/reservations/{batch_key}/fulfillments", headers={"Idempotency-Key": "box"},
                 json={"quantity": 1}).raise_for_status()
        api.post(f"/reservations/{batch_key}/releases", headers={"Idempotency-Key": "customer-edit"},
                 json={"quantity": 1}).raise_for_status()
        now = 110
        first = api.get(URL, params={"limit": 1}).raise_for_status()
        assert first.headers["Cache-Control"] == "no-store"
        first = first.json()
        assert first["captured_at_ms"] == 110_000
        assert first["product"] == {"sku": "KIT-01", "capacity": 19, "available": 11}
        assert first["summary"] == {"reservation_count": 3, "held": 8, "without_deadline_count": 1,
                                    "without_deadline_held": 3, "next_expiry_at_ms": 115_000}
        # Batch IDs are generated. The cursor stays valid if a deadline changes after the first page.
        api.post("/reservations/a-renew/renewals", headers={"Idempotency-Key": "extension"},
                 json={"expected_expires_at_ms": a["expires_at_ms"], "extend_seconds": 15}).raise_for_status()
        now = 111
        rest = api.get(URL, params={"after_id": first["next_after_id"]}).raise_for_status().json()
        all_rows = first["reservations"] + rest["reservations"]
        assert [row["reservation_id"] for row in all_rows] == sorted([batch_key, "a-renew", "b-legacy"])
        assert rest["captured_at_ms"] == 111_000 and rest["next_after_id"] is None
        rows = {row["reservation_id"]: row for row in all_rows}
        assert rows["b-legacy"]["expires_at_ms"] is None
        assert rows[batch_key] == {"reservation_id": batch_key, "batch_id": "z-batch",
                                   "expires_at_ms": 115_000, "quantity": 4, "shipped": 1, "released": 1, "held": 2}
        assert api.get("/reservations/d-timeout").json()["state"] == "expired"
        assert api.get("/inventory/OTHER/allocations").json()["summary"]["held"] == 1
        empty = api.get("/inventory/EMPTY/allocations").raise_for_status().json()
        assert empty["reservations"] == [] and empty["summary"]["held"] == 0
        assert api.get("/inventory/MISSING/allocations").status_code == 404
        for params in ({"limit": 0}, {"limit": 101}, {"after_id": ""}):
            assert api.get(URL, params=params).status_code == 422


def test_report_waits_for_complete_dispatch_and_reconciles_product_with_allocation_totals(tmp_path, monkeypatch):
    path = tmp_path / "dispatch.db"
    writing, reading, proceed = Event(), Event(), Event()
    connect, shipment = Store.connect, Store.record_shipment

    def reader_clock():
        return 103

    def trace_reader(store):
        conn = connect(store)
        if store.clock is reader_clock:
            conn.set_trace_callback(lambda sql: reading.set() if sql == "BEGIN IMMEDIATE" else None)
        return conn

    def first_box(store, conn, key, shipment_id, quantity):
        receipt = shipment(store, conn, key, shipment_id, quantity)
        if key == "a":
            writing.set()
            assert proceed.wait(10)
        return receipt

    monkeypatch.setattr(Store, "connect", trace_reader)
    monkeypatch.setattr(Store, "record_shipment", first_box)
    with TestClient(create_app(path, ttl_seconds=10, clock=lambda: 100)) as sender, \
            TestClient(create_app(path, ttl_seconds=10, clock=reader_clock)) as observer:
        reading.clear()
        hold(sender, "a", 3)
        hold(sender, "b", 4)
        boxes = [{"reservation_id": key, "shipment_id": "box", "quantity": 2} for key in ("a", "b")]
        with ThreadPoolExecutor(max_workers=2) as pool:
            truck = pool.submit(sender.post, "/dispatch-batches", json={"boxes": boxes},
                                headers={"Idempotency-Key": "truck"})
            try:
                assert writing.wait(5)
                report = pool.submit(observer.get, URL, params={"limit": 1})
                assert reading.wait(5)
                assert not report.done()
            finally:
                proceed.set()
            assert truck.result(timeout=10).status_code == 201
            snapshot = report.result(timeout=10).raise_for_status().json()
        assert snapshot["captured_at_ms"] == 103_000
        assert snapshot["product"]["capacity"] == 16
        assert snapshot["product"]["available"] == 13
        assert snapshot["summary"]["held"] == 3
        assert snapshot["summary"]["reservation_count"] == 2
        assert snapshot["reservations"][0]["held"] == 1
        assert snapshot["next_after_id"] == "a"


def test_published_allocation_example_is_reproducible(tmp_path):
    saved = Path(__file__).parents[1] / "examples" / "sku-allocation-demo.json"
    assert capture(tmp_path / "demo.db") == json.loads(saved.read_text(encoding="utf-8"))
