from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from contextlib import closing
import sqlite3
from threading import Barrier, Event

import pytest
from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "stock.db")) as http:
        yield http


def reserve(client, key, quantity=1, sku="KIT-01"):
    return client.post("/reservations", headers={"Idempotency-Key": key},
                       json={"quantity": quantity, "sku": sku})


def available(client):
    return client.get("/inventory").json()[0]["available"]


def test_replay_and_release(client):
    first = reserve(client, "web-1", 3)
    assert first.status_code == 201
    replay = reserve(client, "web-1", 3)
    assert replay.status_code == 200 and replay.json() == first.json()
    assert reserve(client, "web-1", 5).status_code == 409
    assert available(client) == 17
    for _ in range(2):
        assert client.delete("/reservations/web-1").json()["state"] == "released"
    assert reserve(client, "web-1", 3).json()["state"] == "released"
    assert available(client) == 20


def test_concurrent_last_units(client):
    with ThreadPoolExecutor(max_workers=10) as pool:
        codes = list(pool.map(lambda i: reserve(client, f"r{i}", 2).status_code, range(24)))
    assert codes.count(201) == 10
    assert codes.count(409) == 14
    assert available(client) == 0


def test_duplicate_requests_in_parallel(client):
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(lambda _: reserve(client, "retry", 7).status_code, range(12)))
    assert codes.count(201) == 1 and codes.count(200) == 11
    assert available(client) == 13


@pytest.mark.parametrize("qty", [0, -1, 1.5, True, "2"])
def test_invalid_quantity(client, qty):
    assert reserve(client, "bad", qty).status_code == 422
    assert available(client) == 20


def test_missing_and_failed_retry(client):
    assert reserve(client, "key", sku="OTHER").status_code == 404
    assert client.delete("/reservations/absent").status_code == 404
    assert reserve(client, "key", 21).status_code == 409
    assert reserve(client, "key", 20).status_code == 201


def test_restart_persists(tmp_path: Path):
    path = tmp_path / "store.db"
    with TestClient(create_app(path)) as client:
        reserve(client, "persistent", 7)
    with TestClient(create_app(path)) as restarted:
        assert available(restarted) == 13
        assert reserve(restarted, "persistent", 7).status_code == 200


def test_deadline_survives_restart_and_retry_does_not_extend_it(tmp_path):
    path = tmp_path / "stock.db"
    now = 1000
    with TestClient(create_app(path, ttl_seconds=10, clock=lambda: now)) as client:
        first = reserve(client, "old", 20)
        deadline = first.json()["expires_at_ms"]
        assert deadline == 1_010_000
        now = 1009
        assert reserve(client, "old", 20).json() == first.json()
        assert available(client) == 0
    now = 1010
    with TestClient(create_app(path, ttl_seconds=60, clock=lambda: now)) as client:
        assert reserve(client, "new", 20).status_code == 201
        replay = reserve(client, "old", 20)
        assert replay.status_code == 200
        assert replay.json()["state"] == "expired"
        assert replay.json()["expires_at_ms"] == deadline
        assert available(client) == 0


def test_cancel_before_deadline_is_final(tmp_path):
    now = 0
    with TestClient(create_app(tmp_path / "store.db", ttl_seconds=5, clock=lambda: now)) as client:
        reserve(client, "early", 2)
        now = 4
        assert client.delete("/reservations/early").json()["state"] == "released"
        now = 5
        assert available(client) == 20
        assert reserve(client, "early", 2).json()["state"] == "released"


def test_cancellation_replay_and_new_buyer_racing_at_expiry(tmp_path):
    now = 100
    with TestClient(create_app(tmp_path / "store.db", ttl_seconds=1, clock=lambda: now)) as client:
        assert reserve(client, "old", 20).status_code == 201
        now += 1
        start = Barrier(3)

        def race(action):
            start.wait(timeout=10)
            return action()

        with ThreadPoolExecutor(max_workers=3) as pool:
            cancel, replay, buyer = list(pool.map(race, [
                lambda: client.delete("/reservations/old"),
                lambda: reserve(client, "old", 20),
                lambda: reserve(client, "new", 19),
            ]))
        assert cancel.json()["state"] == replay.json()["state"] == "expired"
        assert buyer.status_code == 201
        assert available(client) == 1


def test_upgrades_database_without_inventing_deadlines_for_old_holds(tmp_path):
    path = tmp_path / "legacy.db"
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER,
                                      state TEXT CHECK (state IN ('held','released')));
            INSERT INTO products VALUES ('KIT-01',20,13);
            INSERT INTO reservations VALUES ('legacy','KIT-01',7,'held');
        """)
    with TestClient(create_app(path, clock=lambda: 1000)) as client:
        assert available(client) == 13
        old = reserve(client, "legacy", 7).json()
        assert old["expires_at_ms"] is None and old["state"] == "held"
        assert ship(client, "legacy", "first-box", 3).status_code == 201
        assert client.delete("/reservations/legacy").json()["state"] == "released"
        assert available(client) == 17


def ship(client, key, shipment, quantity):
    return client.post(f"/reservations/{key}/fulfillments", headers={"Idempotency-Key": shipment},
                       json={"quantity": quantity})


def counts(client, key):
    progress = client.get(f"/reservations/{key}").json()
    assert progress["quantity"] == progress["shipped"] + progress["held"] + progress["returned"]
    return progress["state"], progress["shipped"], progress["held"], progress["returned"]


def test_partial_dispatch_replay_restart_and_expiry(tmp_path):
    path = tmp_path / "warehouse.db"
    now = 100
    with TestClient(create_app(path, ttl_seconds=10, clock=lambda: now)) as http:
        reserve(http, "order", 8)
        first = ship(http, "order", "box-1", 3)
        assert first.status_code == 201
        assert first.json() == {"reservation_id": "order", "shipment_id": "box-1", "quantity": 3, "held_after": 5}
        assert ship(http, "order", "box-2", 2).json()["held_after"] == 3
        assert counts(http, "order") == ("held", 5, 3, 0)
        assert http.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 15, "available": 12}]
    now = 110
    with TestClient(create_app(path, clock=lambda: now)) as http:
        assert ship(http, "order", "late", 1).status_code == 409
        replay = ship(http, "order", "box-1", 3)
        assert replay.status_code == 200 and replay.json() == first.json()
        assert ship(http, "order", "box-1", 1).status_code == 409
        assert counts(http, "order") == ("expired", 5, 0, 3)
        assert http.delete("/reservations/order").json()["state"] == "expired"
        assert available(http) == 15


def test_concurrent_shipments_against_two_service_instances(tmp_path):
    path = tmp_path / "shared.db"
    with TestClient(create_app(path)) as left, TestClient(create_app(path)) as right:
        reserve(left, "r", 8)
        clients = [left, right]
        with ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(pool.map(lambda i: ship(clients[i % 2], "r", "retry", 3), range(12)))
            assert [r.status_code for r in replies].count(201) == 1
            assert [r.status_code for r in replies].count(200) == 11
            assert all(r.json() == replies[0].json() for r in replies)
            replies = list(pool.map(lambda i: ship(clients[i % 2], "r", f"box-{i}", 1), range(12)))
            codes = [r.status_code for r in replies]
            assert codes.count(201) == 5 and codes.count(409) == 7
        assert counts(right, "r") == ("fulfilled", 8, 0, 0)
        assert left.delete("/reservations/r").json()["state"] == "fulfilled"
        assert reserve(right, "r", 8).json()["state"] == "fulfilled"
        assert left.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 12, "available": 12}]


def test_cancel_and_dispatch_race_returns_only_unshipped_units(client):
    reserve(client, "order", 8)
    assert ship(client, "order", "early", 2).status_code == 201
    start = Barrier(2)

    def dispatch():
        start.wait(timeout=10)
        return ship(client, "order", "late", 3)

    with ThreadPoolExecutor() as pool:
        attempt = pool.submit(dispatch)
        start.wait(timeout=10)
        assert client.delete("/reservations/order").json()["state"] == "released"
        code = attempt.result().status_code
    assert code in (201, 409)
    shipped = 5 if code == 201 else 2
    assert counts(client, "order") == ("released", shipped, 0, 8 - shipped)
    assert available(client) == 20 - shipped


def test_failed_shipment_leaves_key_and_stock_available(client):
    assert ship(client, "r", "box", 1).status_code == 404
    assert client.get("/reservations/r").status_code == 404
    for key in ["r", "s"]:
        reserve(client, key, 2)
        assert ship(client, key, "box", True).status_code == 422
        assert ship(client, key, "box", 3).status_code == 409
        assert ship(client, key, "box", 2).status_code == 201
        assert counts(client, key) == ("fulfilled", 2, 0, 0)


def test_receipt_insert_failure_rolls_back_all_stock_changes(tmp_path):
    path = tmp_path / "warehouse.db"
    with TestClient(create_app(path), raise_server_exceptions=False) as http:
        reserve(http, "r", 4)
        with closing(sqlite3.connect(path)) as db:
            db.execute("""CREATE TRIGGER stop_receipt BEFORE INSERT ON fulfillments
                          BEGIN SELECT RAISE(ABORT, 'simulated receipt failure'); END""")
            assert ship(http, "r", "box", 4).status_code == 500
            assert counts(http, "r") == ("held", 0, 4, 0)
            assert http.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 20, "available": 16}]
            db.execute("DROP TRIGGER stop_receipt")
        assert ship(http, "r", "box", 4).status_code == 201


def test_request_waiting_for_writer_cannot_dispatch_past_deadline(tmp_path, monkeypatch):
    path = tmp_path / "locked.db"
    now = 100
    with TestClient(create_app(path, ttl_seconds=1, clock=lambda: now)) as http:
        reserve(http, "r", 8)
        assert ship(http, "r", "early", 3).status_code == 201
        connected = Event()
        original = Store.connect

        def connect(store):
            db = original(store)
            connected.set()
            return db

        monkeypatch.setattr(Store, "connect", connect)
        with closing(sqlite3.connect(path)) as writer, ThreadPoolExecutor() as pool:
            writer.execute("BEGIN IMMEDIATE")
            try:
                attempt = pool.submit(ship, http, "r", "late", 5)
                assert connected.wait(timeout=5)
                now = 101
            finally:
                writer.rollback()
            assert attempt.result(timeout=5).status_code == 409
        assert counts(http, "r") == ("expired", 3, 0, 5)
        assert available(http) == 17


def test_upgrades_deadline_schema_and_preserves_earlier_states(tmp_path):
    path = tmp_path / "v1-1.db"
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT,
                                      expires_at_ms INTEGER, timed_out INTEGER NOT NULL DEFAULT 0);
            INSERT INTO products VALUES ('KIT-01',20,12);
            INSERT INTO reservations VALUES ('open','KIT-01',8,'held',100000,0);
            INSERT INTO reservations VALUES ('old','KIT-01',4,'released',1000,1);
        """)
    with TestClient(create_app(path, clock=lambda: 50)) as http:
        assert counts(http, "old") == ("expired", 0, 0, 4)
        assert counts(http, "open") == ("held", 0, 8, 0)
        assert ship(http, "open", "box", 3).status_code == 201
    with TestClient(create_app(path, clock=lambda: 100)) as http:
        assert counts(http, "open") == ("expired", 3, 0, 5)
        assert available(http) == 17
