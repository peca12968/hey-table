from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


def create(client, items, batch="cart"):
    return client.post("/reservation-batches", headers={"Idempotency-Key": batch}, json={
        "items": [{"sku": sku, "quantity": quantity} for sku, quantity in items],
    }).raise_for_status().json()


def route(batch="cart"):
    return f"/reservation-batches/{batch}/replacement"


def replace(client, batch="cart", request="continue"):
    return client.post(route(batch), headers={"Idempotency-Key": request})


def test_batch_replacement_waits_for_all_holds_and_rolls_back_on_late_sku_shortage(tmp_path):
    db = tmp_path / "warehouse.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(db, ttl_seconds=5, clock=clock)) as client:
        with Store(db).transaction() as conn:
            conn.executemany("INSERT INTO products VALUES (?,?,?)", [("DONE-01", 4, 4), ("WRAP-01", 3, 3)])
        source = create(client, [("KIT-01", 4), ("WRAP-01", 3), ("DONE-01", 1)])
        done, kit, wrap = [line["id"] for line in source["items"]]
        for key in (done, kit):
            assert client.post(f"/reservations/{key}/fulfillments", headers={"Idempotency-Key": "box"},
                               json={"quantity": 1}).status_code == 201
        assert client.post(f"/reservations/{kit}/releases", headers={"Idempotency-Key": "edit"},
                           json={"quantity": 1}).status_code == 201
        assert client.post(f"/reservations/{wrap}/renewals", headers={"Idempotency-Key": "delay"},
                           json={"expected_expires_at_ms": 105_000, "extend_seconds": 3}).status_code == 201
        now = 105
        assert replace(client, "missing").status_code == 404
        assert replace(client).json() == {"detail": "Reservation batch still has active holds"}
        assert client.get(route()).status_code == 404
        now = 108
        assert client.post("/reservations", headers={"Idempotency-Key": "other"}, json={
            "sku": "WRAP-01", "quantity": 3,
        }).status_code == 201
        before = client.get("/inventory").json()
        conflict = replace(client)
        assert conflict.status_code == 409 and conflict.json() == {"detail": "WRAP-01: Insufficient stock"}
        assert client.get("/inventory").json() == before
        assert client.get(route()).status_code == 404
        assert client.get(f"/reservations/{kit}/replacement").status_code == 404
        assert client.delete("/reservations/other").status_code == 200

        response = replace(client)
        assert response.status_code == 201 and response.headers["Cache-Control"] == "no-store"
        receipt = response.json()
        assert receipt["source_batch_id"] == "cart" and receipt["batch_id"] != "cart"
        assert receipt["created_at_ms"] == 108_000 and receipt["expires_at_ms"] == 113_000
        assert [(row["source_id"], row["sku"], row["quantity"]) for row in receipt["items"]] == [
            (kit, "KIT-01", 2), (wrap, "WRAP-01", 3),
        ]
        for item in receipt["items"]:
            parent = item["source_id"]
            assert client.get(f"/reservations/{parent}/replacement").json()["reservation"]["id"] == item["id"]
            assert client.post(f"/reservations/{parent}/replacement", headers={"Idempotency-Key": "continue"}).status_code == 409
        active = client.get(f"/reservation-batches/{receipt['batch_id']}/status").raise_for_status().json()
        assert [(row["sku"], row["held"]) for row in active["items"]] == [("KIT-01", 2), ("WRAP-01", 3)]
        assert [row["state"] for row in client.get("/reservation-batches/cart/status").json()["items"]] == [
            "fulfilled", "expired", "expired",
        ]
        assert replace(client, request="different").status_code == 409

    now = 109
    with TestClient(create_app(db, ttl_seconds=5, clock=clock)) as restarted:
        assert restarted.delete(f"/reservation-batches/{receipt['batch_id']}").status_code == 200
        replay = replace(restarted)
        assert replay.status_code == 200 and replay.json() == receipt
        read = restarted.get(route())
        assert read.json() == receipt and read.headers["Cache-Control"] == "no-store"
        assert restarted.get("/inventory").json() == [
            {"sku": "DONE-01", "capacity": 3, "available": 3},
            {"sku": "KIT-01", "capacity": 19, "available": 19},
            {"sku": "WRAP-01", "capacity": 3, "available": 3},
        ]


def test_batch_and_single_replacement_serialize_without_leaving_partial_holds(tmp_path):
    db = tmp_path / "competition.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(db, ttl_seconds=5, clock=clock)) as first, \
            TestClient(create_app(db, ttl_seconds=5, clock=clock)) as second:
        with Store(db).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',3,3)")
        source = create(first, [("KIT-01", 2), ("WRAP-01", 3)])
        kit, wrap = [line["id"] for line in source["items"]]
        now = 105
        ready = Barrier(2, timeout=5)

        def batch():
            ready.wait()
            return replace(first)

        def single():
            ready.wait()
            return second.post(f"/reservations/{wrap}/replacement", headers={"Idempotency-Key": "continue"})

        with ThreadPoolExecutor(max_workers=2) as pool:
            one, two = pool.submit(batch), pool.submit(single)
            grouped, individual = one.result(timeout=10), two.result(timeout=10)
        assert sorted([grouped.status_code, individual.status_code]) == [201, 409]
        batch_won = grouped.status_code == 201
        assert first.get(route()).status_code == (200 if batch_won else 404)
        assert first.get(f"/reservations/{kit}/replacement").status_code == (200 if batch_won else 404)
        assert first.get("/inventory").json()[0]["available"] == (18 if batch_won else 20)
        assert first.get("/inventory").json()[1]["available"] == 0


def test_batch_replacement_upgrades_existing_db_and_rolls_back_if_receipt_fails(tmp_path):
    db = tmp_path / "upgrade.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(db, ttl_seconds=5, clock=clock)) as client:
        source = create(client, [("KIT-01", 2)])
        create(client, [("KIT-01", 1)], "cancelled")
        with Store(db).transaction() as conn:
            conn.execute("DROP TABLE reservation_batch_replacements")
    now = 105
    with TestClient(create_app(db, ttl_seconds=5, clock=clock), raise_server_exceptions=False) as upgraded:
        assert upgraded.delete("/reservation-batches/cancelled").status_code == 200
        assert replace(upgraded, "cancelled").status_code == 409
        store = Store(db)
        with store.transaction() as conn:
            conn.execute("""CREATE TRIGGER fail_header BEFORE INSERT ON reservation_batch_replacements
                            BEGIN SELECT RAISE(ABORT,'receipt rejected'); END""")
        assert replace(upgraded).status_code == 500
        assert upgraded.get(route()).status_code == 404
        assert upgraded.get(f"/reservations/{source['items'][0]['id']}/replacement").status_code == 404
        assert upgraded.get("/inventory").json()[0]["available"] == 20
        with store.transaction() as conn:
            assert conn.execute("SELECT COUNT(*) FROM reservations").fetchone()[0] == 2
            conn.execute("DROP TRIGGER fail_header")
        assert replace(upgraded).status_code == 201
        assert upgraded.get("/inventory").json()[0]["available"] == 18
