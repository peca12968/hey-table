from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


QUEUE = "/expiring-reservations"
HISTORY = "/expired-reservations"


def hold(api, key, quantity=1):
    return api.post("/reservations", headers={"Idempotency-Key": key},
                    json={"sku": "KIT-01", "quantity": quantity}).raise_for_status().json()


def test_expiry_queue_pages_matching_live_reservations_from_one_cutoff(tmp_path):
    now = 100
    database = tmp_path / "queue.db"
    with TestClient(create_app(database, ttl_seconds=10, clock=lambda: now)) as api:
        hold(api, "due")
        now = 101
        for key in ("east", "centre", "west"):
            hold(api, key, 4)
        with Store(database).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01', 2, 0)")
            conn.execute("INSERT INTO reservations(id,sku,quantity,state) VALUES ('legacy','WRAP-01',1,'held')")
            conn.execute("""INSERT INTO reservations(id,sku,quantity,state,expires_at_ms)
                            VALUES ('wrapping','WRAP-01',1,'held',111000)""")
        assert api.post("/reservations/centre/fulfillments", headers={"Idempotency-Key": "box"},
                        json={"quantity": 1}).status_code == 201
        assert api.post("/reservations/centre/releases", headers={"Idempotency-Key": "reduced"},
                        json={"quantity": 1}).status_code == 201
        now = 102
        hold(api, "outside")
        now = 110
        query = {"within_seconds": 1, "limit": 1, "sku": "KIT-01"}
        first = api.get(QUEUE, params=query).raise_for_status()
        assert first.headers["Cache-Control"] == "no-store"
        pages = [first.json()]
        assert pages[0]["captured_at_ms"] == 110_000
        assert pages[0]["through_ms"] == 111_000
        assert pages[0]["reservations"] == [
            {"reservation_id": "centre", "sku": "KIT-01", "held": 2, "shipped": 1,
             "expires_at_ms": 111_000, "batch_id": None},
        ]
        now = 110.5
        for index in range(2):
            pages.append(api.get(QUEUE, params={**query, **pages[index]["next"]}).raise_for_status().json())
        assert [page["reservations"][0]["reservation_id"] for page in pages] == ["centre", "east", "west"]
        assert pages[-1]["next"] is None and all(page["through_ms"] == 111_000 for page in pages)
        assert pages[-1]["captured_at_ms"] == 110_500
        assert [row["reservation_id"] for row in api.get(QUEUE, params={"sku": "WRAP-01"}).json()["reservations"]] == ["wrapping"]
        assert api.get("/reservations/due").json()["state"] == "expired"
        assert api.get("/reservations/legacy").json()["state"] == "held"
        for invalid in ({"within_seconds": 0}, {"limit": 101}, {"after_id": "east"},
                        {"through_ms": 111_000, "after_id": "east", "after_expires_at_ms": 112_000},
                        {"through_ms": 999_999_999}):
            assert api.get(QUEUE, params=invalid).status_code == 422


def test_queue_waits_for_the_entire_dispatch_batch(tmp_path, monkeypatch):
    database = tmp_path / "dispatch.db"
    writing, reading, proceed = Event(), Event(), Event()
    connect, shipment = Store.connect, Store.record_shipment

    def reader_clock():
        return 103

    def trace_reader(store):
        conn = connect(store)
        if store.clock is reader_clock:
            conn.set_trace_callback(lambda sql: reading.set() if sql == "BEGIN IMMEDIATE" else None)
        return conn

    def pause_after_box(store, conn, key, shipment_id, quantity):
        result = shipment(store, conn, key, shipment_id, quantity)
        if key == "a":
            writing.set()
            assert proceed.wait(10)
        return result

    monkeypatch.setattr(Store, "connect", trace_reader)
    monkeypatch.setattr(Store, "record_shipment", pause_after_box)
    with TestClient(create_app(database, ttl_seconds=5, clock=lambda: 100)) as sender, \
            TestClient(create_app(database, ttl_seconds=5, clock=reader_clock)) as observer:
        reading.clear()
        hold(sender, "a", 2)
        hold(sender, "b", 2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            dispatch = pool.submit(sender.post, "/dispatch-batches", headers={"Idempotency-Key": "truck"},
                                   json={"boxes": [{"reservation_id": key, "shipment_id": "box", "quantity": 1}
                                                   for key in ("a", "b")]})
            try:
                assert writing.wait(5)
                queued = pool.submit(observer.get, QUEUE, params={"within_seconds": 2})
                assert reading.wait(5)
                assert not queued.done()
            finally:
                proceed.set()
            assert dispatch.result(timeout=10).status_code == 201
            snapshot = queued.result(timeout=10).raise_for_status().json()
        assert snapshot["captured_at_ms"] == 103_000
        assert [(item["reservation_id"], item["shipped"], item["held"]) for item in snapshot["reservations"]] == [
            ("a", 1, 1), ("b", 1, 1),
        ]


def test_history_pages_track_first_reclaim_and_exact_remaining_units(tmp_path):
    now = 100
    database = tmp_path / "history.db"
    with TestClient(create_app(database, ttl_seconds=10, clock=lambda: now)) as api:
        with Store(database).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',5,5)")
        hold(api, "a", 5)
        hold(api, "z", 2)
        hold(api, "cancelled", 1)
        assert api.delete("/reservations/cancelled").status_code == 200
        assert api.post("/reservations/a/fulfillments", headers={"Idempotency-Key": "box"},
                        json={"quantity": 2}).status_code == 201
        assert api.post("/reservations/a/releases", headers={"Idempotency-Key": "customer-edit"},
                        json={"quantity": 1}).status_code == 201
        batch = api.post("/reservation-batches", headers={"Idempotency-Key": "bundle"},
                         json={"items": [{"sku": "WRAP-01", "quantity": 3}]}).raise_for_status().json()
        wrap = batch["items"][0]["id"]
        now = 105
        hold(api, "later")
        now = 112
        query = {"sku": "KIT-01", "limit": 1, "since_ms": 110_000}
        response = api.get(HISTORY, params=query).raise_for_status()
        assert response.headers["Cache-Control"] == "no-store"
        first = response.json()
        assert first["captured_at_ms"] == first["through_ms"] == 112_000
        assert first["since_ms"] == 110_000
        assert first["next"] == {"through_ms": 112_000, "before_expires_at_ms": 110_000, "before_id": "z"}
        assert first["reservations"][0]["reservation_id"] == "z"
        assert first["reservations"][0]["reclaimed"] == 2
        assert api.get(HISTORY, params={"through_ms": 111_999}).json()["reservations"] == []
        now = 115
        second = api.get(HISTORY, params={**query, **first["next"]}).raise_for_status().json()
        assert second == {"captured_at_ms": 115_000, "through_ms": 112_000, "since_ms": 110_000, "next": None,
                          "reservations": [{"reservation_id": "a", "sku": "KIT-01", "batch_id": None,
                                            "expires_at_ms": 110_000, "reclaimed_at_ms": 112_000, "quantity": 5,
                                            "shipped": 2, "released_before_expiry": 1, "reclaimed": 2}]}
        third = api.get(HISTORY, params={"sku": "WRAP-01"}).json()["reservations"]
        assert [(r["reservation_id"], r["batch_id"], r["reclaimed"]) for r in third] == [(wrap, "bundle", 3)]
        fresh = api.get(HISTORY, params={"since_ms": 115_000}).json()["reservations"]
        assert [(r["reservation_id"], r["reclaimed_at_ms"]) for r in fresh] == [("later", 115_000)]
        assert api.get("/inventory").json() == [
            {"sku": "KIT-01", "capacity": 18, "available": 18},
            {"sku": "WRAP-01", "capacity": 5, "available": 5},
        ]
        for bad in ({"limit": 101}, {"before_id": "z"}, {"since_ms": 115_001},
                    {"through_ms": 115_001}, {"through_ms": 112_000, "before_expires_at_ms": 114_000, "before_id": "z"}):
            assert api.get(HISTORY, params=bad).status_code == 422


def test_two_instances_reclaim_once_and_restart_returns_same_event(tmp_path):
    database = tmp_path / "shared-history.db"
    now = 100
    start = Barrier(8, timeout=10)
    with TestClient(create_app(database, ttl_seconds=10, clock=lambda: now)) as left, \
            TestClient(create_app(database, ttl_seconds=10, clock=lambda: now)) as right:
        hold(left, "cart", 12)
        assert left.post("/reservations/cart/fulfillments", headers={"Idempotency-Key": "box"},
                         json={"quantity": 3}).status_code == 201
        now = 110

        def read(index):
            start.wait()
            return (left if index % 2 else right).get(HISTORY).raise_for_status().json()

        with ThreadPoolExecutor(max_workers=8) as pool:
            pages = list(pool.map(read, range(8)))
        assert all(page == pages[0] for page in pages)
        expected = pages[0]["reservations"]
        assert len(expected) == 1
        assert expected[0]["reclaimed"] == 9
        assert expected[0]["reclaimed_at_ms"] == expected[0]["expires_at_ms"] == 110_000
        assert right.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 17, "available": 17}]
    with TestClient(create_app(database, clock=lambda: 150)) as restarted:
        assert restarted.get(HISTORY).raise_for_status().json()["reservations"] == expected
