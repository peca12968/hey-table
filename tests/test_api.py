from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

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
