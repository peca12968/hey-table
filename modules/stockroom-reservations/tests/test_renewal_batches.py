from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


ENDPOINT = "/renewal-batches"


def hold(client, key, quantity=2):
    return client.post("/reservations", headers={"Idempotency-Key": key},
                       json={"sku": "KIT-01", "quantity": quantity}).raise_for_status().json()


def item(key, deadline=105_000):
    return {"reservation_id": key, "expected_expires_at_ms": deadline}


def renew(client, batch_id, items, seconds=10):
    return client.post(ENDPOINT, headers={"Idempotency-Key": batch_id},
                       json={"items": items, "extend_seconds": seconds})


def test_renewal_batch_rejects_stale_member_and_replays_an_original_receipt_after_expiry(tmp_path):
    database = tmp_path / "renew.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as client:
        hold(client, "a", 4)
        hold(client, "z")
        assert client.post("/reservations/a/fulfillments", headers={"Idempotency-Key": "box"},
                           json={"quantity": 1}).status_code == 201
        stale = renew(client, "night", [item("a"), item("z", 105_001)])
        assert stale.status_code == 409
        assert stale.json() == {
            "detail": "z: Reservation deadline changed",
        }
        assert client.get(ENDPOINT + "/night").status_code == 404
        assert client.get("/reservations/a").json()["expires_at_ms"] == 105_000
        assert renew(client, "duplicate", [item("a"), item("a")]).status_code == 422
        assert renew(client, "invalid", [item("a")], seconds=True).status_code == 422
        assert renew(client, "unknown", [item("a"), item("unknown")]).status_code == 404
        response = renew(client, "night", [item("z"), item("a")])
        assert response.status_code == 201 and response.headers["Cache-Control"] == "no-store"
        receipt = {"batch_id": "night", "items": [
            {"reservation_id": key, "previous_expires_at_ms": 105_000, "expires_at_ms": 115_000}
            for key in ("a", "z")
        ]}
        assert response.json() == receipt
        assert renew(client, "night", [item("a"), item("z")], seconds=11).status_code == 409
        assert client.get("/reservations/a").json()["held"] == 3
        assert client.get("/reservations/a").json()["shipped"] == 1
        now = 105
        assert client.get("/expiring-reservations", params={"within_seconds": 5}).json()["reservations"] == []
        assert client.get("/reservations/a").json()["state"] == "held"

    now = 115
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as restarted:
        original = restarted.get(ENDPOINT + "/night")
        assert original.headers["Cache-Control"] == "no-store"
        assert original.json() == receipt
        replay = renew(restarted, "night", [item("a"), item("z")])
        assert replay.status_code == 200 and replay.json() == receipt
        assert restarted.get("/reservations/a").json()["state"] == "expired"
        assert restarted.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 19, "available": 19}]


def test_batch_competes_with_a_single_renewal_without_a_partial_update(tmp_path):
    database = tmp_path / "compete.db"
    first = create_app(database, ttl_seconds=5, clock=lambda: 100)
    second = create_app(database, ttl_seconds=5, clock=lambda: 100)
    with TestClient(first) as client, TestClient(second) as other:
        hold(client, "a")
        hold(client, "z")
        ready = Barrier(2, timeout=5)

        def batch():
            ready.wait()
            return renew(client, "dispatch", [item("a"), item("z")])

        def single():
            ready.wait()
            return other.post("/reservations/z/renewals", headers={"Idempotency-Key": "dispatch"},
                              json={"expected_expires_at_ms": 105_000, "extend_seconds": 20})

        with ThreadPoolExecutor(max_workers=2) as pool:
            grouped = pool.submit(batch)
            solo = pool.submit(single)
            result, single_result = grouped.result(timeout=10), solo.result(timeout=10)
        assert sorted([result.status_code, single_result.status_code]) == [201, 409]
        deadlines = [client.get(f"/reservations/{key}").json()["expires_at_ms"] for key in ("a", "z")]
        assert deadlines == ([115_000, 115_000] if result.status_code == 201 else [105_000, 125_000])
        assert client.get(ENDPOINT + "/dispatch").status_code == (200 if result.status_code == 201 else 404)


def test_receipt_write_failure_rolls_back_every_renewed_deadline(tmp_path):
    database = tmp_path / "rollback.db"
    with TestClient(create_app(database, ttl_seconds=5, clock=lambda: 100),
                    raise_server_exceptions=False) as client:
        hold(client, "a")
        hold(client, "z")
        store = Store(database)
        with store.transaction() as conn:
            conn.execute("""CREATE TRIGGER reject_last BEFORE INSERT ON reservation_renewal_batches
                            WHEN NEW.reservation_id='z'
                            BEGIN SELECT RAISE(ABORT,'receipt storage failure'); END""")
        assert renew(client, "night", [item("a"), item("z")]).status_code == 500
        assert client.get(ENDPOINT + "/night").status_code == 404
        assert [client.get(f"/reservations/{key}").json()["expires_at_ms"] for key in ("a", "z")] == [105_000, 105_000]
        with store.transaction() as conn:
            conn.execute("DROP TRIGGER reject_last")
        assert renew(client, "night", [item("a"), item("z")]).status_code == 201
