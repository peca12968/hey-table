from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi.testclient import TestClient
import pytest

from stockroom.api import create_app
from stockroom.store import Store


def hold(client, key, quantity):
    return client.post("/reservations", headers={"Idempotency-Key": key}, json={"sku": "KIT-01", "quantity": quantity})


def route(key):
    return f"/reservations/{key}/replacement"


def replace(client, key, request="retry"):
    return client.post(route(key), headers={"Idempotency-Key": request})


def test_replacement_reserves_expired_balance_and_preserves_receipt_after_restart(tmp_path):
    database = tmp_path / "warehouse.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as client:
        assert hold(client, "cart", 8).status_code == 201
        assert replace(client, "missing").status_code == 404
        assert replace(client, "cart").status_code == 409
        assert client.get(route("cart")).status_code == 404
        assert client.post("/reservations/cart/fulfillments", headers={"Idempotency-Key": "shipped"},
                           json={"quantity": 3}).status_code == 201
        assert client.post("/reservations/cart/releases", headers={"Idempotency-Key": "removed"},
                           json={"quantity": 2}).status_code == 201
        now = 105
        assert hold(client, "another-order", 17).status_code == 201
        assert replace(client, "cart").status_code == 409
        assert client.get(route("cart")).status_code == 404
        assert client.delete("/reservations/another-order").status_code == 200
        result = replace(client, "cart")
        assert result.status_code == 201 and result.headers["Cache-Control"] == "no-store"
        receipt = result.json()
        child = receipt["reservation"]["id"]
        assert child != "cart"
        assert receipt == {"source_id": "cart", "created_at_ms": 105_000,
                           "reservation": {"id": child, "sku": "KIT-01", "quantity": 3, "expires_at_ms": 110_000}}
        assert client.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 17, "available": 14}]
        parent = client.get("/reservations/cart").json()
        assert [parent[field] for field in ("state", "shipped", "held", "returned")] == ["expired", 3, 0, 5]
        assert replace(client, "cart", "other-request").status_code == 409
        renewed = client.post(f"/reservations/{child}/renewals", headers={"Idempotency-Key": "keep"},
                              json={"expected_expires_at_ms": 110_000, "extend_seconds": 2})
        assert renewed.status_code == 201

    now = 112
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as restarted:
        recovered = restarted.get(route("cart"))
        assert recovered.headers["Cache-Control"] == "no-store" and recovered.json() == receipt
        replay = replace(restarted, "cart")
        assert replay.status_code == 200 and replay.json() == receipt
        assert restarted.get(f"/reservations/{child}").json()["state"] == "expired"
        successor = replace(restarted, child)
        assert successor.status_code == 201 and successor.json()["source_id"] == child
        assert successor.json()["reservation"]["id"] != child
        assert replace(restarted, "cart").json() == receipt


@pytest.mark.parametrize("same_request", [True, False])
def test_two_services_allocate_only_one_replacement_at_the_expiry_boundary(tmp_path, same_request):
    database = tmp_path / "race.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as client, \
            TestClient(create_app(database, ttl_seconds=5, clock=clock)) as other:
        assert hold(client, "cart", 20).status_code == 201
        now = 105
        ready = Barrier(2, timeout=5)

        def renew(instance, request):
            ready.wait()
            return replace(instance, "cart", request)

        with ThreadPoolExecutor(max_workers=2) as pool:
            one = pool.submit(renew, client, "retry")
            two = pool.submit(renew, other, "retry" if same_request else "alternate")
            results = [future.result(timeout=10) for future in (one, two)]
        assert sorted(result.status_code for result in results) == ([200, 201] if same_request else [201, 409])
        receipt = next(result.json() for result in results if result.status_code == 201)
        assert client.get(route("cart")).json() == receipt
        if same_request:
            assert all(result.json() == receipt for result in results)
        assert client.get("/inventory").json()[0]["available"] == 0
        with Store(database).transaction() as conn:
            assert conn.execute("SELECT COUNT(*) FROM reservations").fetchone()[0] == 2


def test_cancelled_batch_and_legacy_hold_rejected_and_receipt_failure_rolls_back(tmp_path):
    database = tmp_path / "failure.db"
    now = 100
    with TestClient(create_app(database, ttl_seconds=5, clock=lambda: now), raise_server_exceptions=False) as client:
        assert hold(client, "cart", 5).status_code == 201
        assert hold(client, "cancelled", 1).status_code == 201
        assert client.delete("/reservations/cancelled").status_code == 200
        batch = client.post("/reservation-batches", headers={"Idempotency-Key": "order"},
                            json={"items": [{"sku": "KIT-01", "quantity": 1}]}).raise_for_status().json()
        member = batch["items"][0]["id"]
        store = Store(database)
        with store.transaction() as conn:
            conn.execute("INSERT INTO reservations(id,sku,quantity,state) VALUES ('old','KIT-01',1,'held')")
            conn.execute("UPDATE products SET available=available-1")
            conn.execute("""CREATE TRIGGER fail_replacement BEFORE INSERT ON reservation_replacements
                            BEGIN SELECT RAISE(ABORT, 'replacement receipt rejected'); END""")
        now = 105
        assert client.delete("/reservation-batches/order").status_code == 200
        for key in ("cancelled", "old", member):
            assert replace(client, key).status_code == 409
        assert replace(client, "cart").status_code == 500
        assert client.get(route("cart")).status_code == 404
        assert client.get("/inventory").json()[0]["available"] == 19
        with store.transaction() as conn:
            assert conn.execute("SELECT COUNT(*) FROM reservations").fetchone()[0] == 4
            conn.execute("DROP TRIGGER fail_replacement")
        assert replace(client, "cart").status_code == 201
        assert client.get("/inventory").json()[0]["available"] == 14
