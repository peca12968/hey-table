from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.reconcile import reconcile


PRODUCT = "/inventory/KIT-01"
BASIS = PRODUCT + "/count-basis"
ADJUSTMENTS = PRODUCT + "/count-adjustments"


def adjust(client, key, revision, counted, reason="Final recount"):
    return client.post(ADJUSTMENTS, headers={"Idempotency-Key": key}, json={
        "expected_revision": revision, "counted": counted, "count_session": "shift-count", "reason": reason,
    })


def hold(client, units):
    return client.post("/reservations", headers={"Idempotency-Key": "cart"},
                       json={"sku": "KIT-01", "quantity": units}).raise_for_status().json()


def test_count_preserves_confirmed_holds_and_replays_original_receipt(tmp_path):
    now = 100
    path = tmp_path / "live.db"
    opening = tmp_path / "opening.db"
    with TestClient(create_app(path, ttl_seconds=5, clock=lambda: now)) as client:
        assert client.get(BASIS).json()["revision"] == 0
        hold(client, 6)
        with closing(sqlite3.connect(path)) as live, closing(sqlite3.connect(opening)) as saved:
            live.backup(saved)
        basis = client.get(BASIS)
        assert basis.headers["Cache-Control"] == "no-store"
        assert basis.json() == {"sku": "KIT-01", "capacity": 20, "available": 14,
                                "captured_at_ms": 100_000, "held": 6, "revision": 0}
        assert adjust(client, "correct", 0, 5).status_code == 409
        assert client.get(ADJUSTMENTS + "/correct").status_code == 404
        response = adjust(client, "correct", 0, 18, "複點確認短少兩件")
        receipt = response.json()
        assert response.status_code == 201
        assert receipt == {"id": "correct", "sku": "KIT-01", "recorded_at_ms": 100_000, "count_session": "shift-count",
                           "reason": "複點確認短少兩件", "previous_revision": 0, "revision": 1,
                           "previous_capacity": 20, "previous_available": 14, "counted": 18, "available": 12}
        assert client.get("/reservations/cart").json()["held"] == 6
        assert client.get("/inventory/WRAP-01/count-adjustments/correct").status_code == 404
        report = reconcile(opening, path, "KIT-01")
        assert report["balanced"]
        assert report["new_receipts"] == [{"kind": "count_adjustment", "ids": ["correct"], "quantity": -2}]
        assert report["available_changes"]["count_adjustment"] == -2
        assert report["expected_capacity"] == 18

    now = 105
    with TestClient(create_app(path, clock=lambda: now)) as restarted:
        assert restarted.get(BASIS).json() == {"sku": "KIT-01", "capacity": 18, "available": 18,
                                               "captured_at_ms": 105_000, "held": 0, "revision": 1}
        replay = adjust(restarted, "correct", 0, 18, "複點確認短少兩件")
        assert (replay.status_code, replay.json()) == (200, receipt)
        assert restarted.get(ADJUSTMENTS + "/correct").json() == receipt
        assert adjust(restarted, "correct", 0, 18, "Different audit reason").status_code == 409
        unchanged = adjust(restarted, "confirm", 1, 18).raise_for_status().json()
        assert unchanged["previous_revision"] == unchanged["revision"] == 1
        assert adjust(restarted, "empty", 1, 0).raise_for_status().json()["available"] == 0


def test_count_revision_detects_net_zero_movement_and_serializes_two_corrections(tmp_path):
    path = tmp_path / "race.db"
    with TestClient(create_app(path)) as left, TestClient(create_app(path)) as right:
        hold(left, 6)
        start = left.get(BASIS).json()
        assert left.post("/reservations/cart/fulfillments", headers={"Idempotency-Key": "box"},
                         json={"quantity": 2}).status_code == 201
        assert right.post("/reservations/cart/fulfillments/box/returns", headers={"Idempotency-Key": "return"},
                          json={"quantity": 2}).status_code == 201
        basis = right.get(BASIS).json()
        assert basis["capacity"] == start["capacity"] == 20
        assert basis["revision"] == 2
        assert adjust(left, "stale", start["revision"], 21).status_code == 409
        gate = Barrier(2, timeout=5)

        def write(client, key, counted):
            gate.wait()
            return key, adjust(client, key, basis["revision"], counted)

        with ThreadPoolExecutor(max_workers=2) as pool:
            left_write = pool.submit(write, left, "left", 19)
            right_write = pool.submit(write, right, "right", 22)
            results = [left_write.result(timeout=10), right_write.result(timeout=10)]
        assert sorted(response.status_code for _, response in results) == [201, 409]
        receipt = next(response.json() for _, response in results if response.status_code == 201)
        missing = next(key for key, response in results if response.status_code == 409)
        assert right.get(ADJUSTMENTS + "/" + missing).status_code == 404
        assert left.get(BASIS).json()["capacity"] == receipt["counted"]
        assert receipt["revision"] == 3
        assert left.get("/reservations/cart").json()["held"] == 4


def test_count_upgrades_a_legacy_database_and_rolls_back_a_failed_receipt(tmp_path):
    path = tmp_path / "legacy.db"
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT);
            INSERT INTO products VALUES ('KIT-01',20,13);
            INSERT INTO reservations VALUES ('legacy-hold','KIT-01',7,'held');
        """)
    with TestClient(create_app(path, clock=lambda: 100)) as client:
        assert client.get(BASIS).json()["revision"] == 0
        assert client.get(BASIS).json()["held"] == 7
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("""CREATE TRIGGER fail_count BEFORE INSERT ON stock_count_adjustments
                            BEGIN SELECT RAISE(ABORT, 'fixture failed receipt'); END""")
        with pytest.raises(sqlite3.IntegrityError, match="fixture failed receipt"):
            adjust(client, "retry", 0, 17)
        assert client.get(BASIS).json() == {"sku": "KIT-01", "capacity": 20, "available": 13,
                                            "captured_at_ms": 100_000, "held": 7, "revision": 0}
        assert client.get(ADJUSTMENTS + "/retry").status_code == 404
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("DROP TRIGGER fail_count")
        assert adjust(client, "retry", 0, 17).raise_for_status().json()["available"] == 10
        assert adjust(client, "bad", 1, True).status_code == 422
        assert adjust(client, "bad", 1, 18, " ").status_code == 422
