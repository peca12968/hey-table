from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from contextlib import closing
import sqlite3
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from stockroom.api import create_app


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
        assert client.delete("/reservations/legacy").json()["state"] == "released"
        assert available(client) == 20
