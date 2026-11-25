from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Barrier, Event

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.reconcile import reconcile
from stockroom.store import Store


ENDPOINT = "/release-batches"


def hold(client, key, quantity, sku="KIT-01"):
    return client.post("/reservations", headers={"Idempotency-Key": key},
                       json={"sku": sku, "quantity": quantity}).raise_for_status().json()


def item(key, expected, quantity):
    return {"reservation_id": key, "expected_held": expected, "quantity": quantity}


def release(client, batch_id, items):
    return client.post(ENDPOINT, headers={"Idempotency-Key": batch_id}, json={"items": items})


def shipment(client, key, quantity):
    return client.post(f"/reservations/{key}/fulfillments", headers={"Idempotency-Key": "box"},
                       json={"quantity": quantity})


def single_release(client, key, receipt, quantity):
    return client.post(f"/reservations/{key}/releases", headers={"Idempotency-Key": receipt},
                       json={"quantity": quantity})


def test_release_reviews_current_holds_and_replays_across_restart_and_expiry(tmp_path):
    path = tmp_path / "warehouse.db"
    now = 100
    clock = lambda: now
    with TestClient(create_app(path, ttl_seconds=5, clock=clock)) as client:
        with Store(path).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',10,10)")
        hold(client, "a", 6)
        hold(client, "z", 4, "WRAP-01")
        assert shipment(client, "a", 2).status_code == 201
        items = [item("z", 4, 4), item("a", 4, 2)]
        before = client.get("/inventory").json()
        stale = release(client, "desk", [item("z", 5, 4), items[1]])
        assert stale.status_code == 409 and stale.json() == {"detail": "z: Remaining hold changed"}
        assert release(client, "desk", [item("z", 4, 5), items[1]]).status_code == 409
        assert release(client, "desk", [item("unknown", 1, 1), items[1]]).status_code == 404
        assert release(client, "desk", [items[1], items[1]]).status_code == 422
        assert release(client, "desk", [item("a", True, 1)]).status_code == 422
        assert client.get("/inventory").json() == before
        assert client.get(ENDPOINT + "/desk").status_code == 404

        accepted = release(client, "desk", items)
        assert accepted.status_code == 201 and accepted.headers["Cache-Control"] == "no-store"
        receipt = {"batch_id": "desk", "released_at_ms": 100_000, "items": [
            {"reservation_id": "a", "held_before": 4, "quantity": 2, "held_after": 2},
            {"reservation_id": "z", "held_before": 4, "quantity": 4, "held_after": 0},
        ]}
        assert accepted.json() == receipt
        assert release(client, "desk", [items[1], item("z", 4, 1)]).status_code == 409
        assert release(client, "desk", [item("a", 5, 2), items[0]]).status_code == 409
        assert client.get("/inventory").json() == [
            {"sku": "KIT-01", "capacity": 18, "available": 16},
            {"sku": "WRAP-01", "capacity": 10, "available": 10},
        ]
        single = client.post("/reservations/a/releases", headers={"Idempotency-Key": "desk"}, json={"quantity": 1})
        assert single.status_code == 201 and single.json()["held_after"] == 1

    now = 105
    with TestClient(create_app(path, ttl_seconds=5, clock=clock)) as restarted:
        recovered = restarted.get(ENDPOINT + "/desk")
        assert recovered.headers["Cache-Control"] == "no-store" and recovered.json() == receipt
        replay = release(restarted, "desk", items[::-1])
        assert replay.status_code == 200 and replay.json() == receipt
        assert release(restarted, "new", [item("a", 1, 1)]).status_code == 409
        progress = restarted.get("/reservations/a").json()
        assert (progress["state"], progress["shipped"], progress["held"], progress["returned"]) == ("expired", 2, 0, 4)
        assert restarted.get("/inventory").json()[0] == {"sku": "KIT-01", "capacity": 18, "available": 18}


def test_release_batch_and_shipment_compete_without_committing_a_partial_batch(tmp_path):
    path = tmp_path / "parallel.db"
    app = create_app(path, clock=lambda: 100)
    other_app = create_app(path, clock=lambda: 100)
    with TestClient(app) as client, TestClient(other_app) as other:
        hold(client, "a", 4)
        hold(client, "z", 2)
        ready = Barrier(2, timeout=5)

        def batch():
            ready.wait()
            return release(client, "desk", [item("a", 4, 2), item("z", 2, 2)])

        def dispatch():
            ready.wait()
            return shipment(other, "z", 1)

        with ThreadPoolExecutor(max_workers=2) as pool:
            grouped, dispatched = pool.submit(batch), pool.submit(dispatch)
            result, box = grouped.result(timeout=10), dispatched.result(timeout=10)
        assert sorted([result.status_code, box.status_code]) == [201, 409]
        released = result.status_code == 201
        assert client.get("/reservations/a").json()["held"] == (2 if released else 4)
        assert client.get("/reservations/z").json()["held"] == (0 if released else 1)
        assert client.get(ENDPOINT + "/desk").status_code == (200 if released else 404)
        assert client.get("/inventory").json() == [
            {"sku": "KIT-01", "capacity": 20 if released else 19, "available": 18 if released else 14},
        ]


def test_old_holds_and_release_ledger_survive_a_batch_receipt_write_rollback(tmp_path):
    opening, path = tmp_path / "old.db", tmp_path / "warehouse.db"
    with closing(sqlite3.connect(opening)) as conn, closing(sqlite3.connect(path)) as upgraded:
        conn.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT);
            INSERT INTO products VALUES ('KIT-01',20,13);
            INSERT INTO reservations VALUES ('a','KIT-01',4,'held'), ('z','KIT-01',3,'held');
        """)
        conn.backup(upgraded)
    with TestClient(create_app(path, clock=lambda: 100), raise_server_exceptions=False) as client:
        store = Store(path)
        with store.transaction() as conn:
            conn.execute("""CREATE TRIGGER fail_final_receipt BEFORE INSERT ON reservation_release_batches
                            WHEN NEW.reservation_id='z' BEGIN SELECT RAISE(ABORT, 'last receipt failed'); END""")
        items = [item("a", 4, 2), item("z", 3, 1)]
        assert release(client, "desk", items).status_code == 500
        assert client.get("/reservations/a").json()["held"] == 4
        assert client.get("/reservations/z").json()["held"] == 3
        assert client.get("/inventory").json()[0]["available"] == 13
        assert client.get(ENDPOINT + "/desk").status_code == 404
        with store.transaction() as conn:
            assert conn.execute("SELECT COUNT(*) FROM reservation_releases").fetchone()[0] == 0
            conn.execute("DROP TRIGGER fail_final_receipt")
        assert release(client, "desk", items).status_code == 201
        assert client.get("/reservations/z").json()["expires_at_ms"] is None
        assert release(client, "desk", items[::-1]).status_code == 200
    report = reconcile(opening, path, "KIT-01")
    assert report["balanced"]
    assert report["available_changes"]["partial_release"] == 3
    assert report["closing"] == {"capacity": 20, "available": 16, "held": 4}


def test_release_history_pages_keep_the_original_order_through_upgrade_and_expiry(tmp_path):
    database = tmp_path / "history.db"
    now = 100
    clock = lambda: now
    history = "/reservations/a/releases"
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as client:
        hold(client, "a", 8)
        hold(client, "z", 2)
        assert shipment(client, "a", 1).status_code == 201
        old = single_release(client, "a", "legacy", 1)
        assert old.status_code == 201
        assert release(client, "desk", [item("a", 6, 2), item("z", 2, 1)]).status_code == 201

    # Keep both types of existing receipt while simulating the schema before single-release timestamps.
    with Store(database).transaction() as conn:
        conn.execute("ALTER TABLE reservation_releases DROP COLUMN released_at_ms")
    now = 101
    with TestClient(create_app(database, ttl_seconds=5, clock=clock)) as client:
        old_replay = single_release(client, "a", "legacy", 1)
        assert old_replay.status_code == 200 and old_replay.json() == old.json()
        assert single_release(client, "a", "desk", 1).status_code == 201
        response = client.get(history, params={"limit": 1}).raise_for_status()
        assert response.headers["Cache-Control"] == "no-store"
        expected_head = {"source": "single", "receipt_id": "desk", "released_at_ms": 101_000,
                         "held_before": 4, "quantity": 1, "held_after": 3}
        first = response.json()
        assert first == {"captured_at_ms": 101_000, "reservation": client.get("/reservations/a").json(),
                         "releases": [expected_head], "next_after_held": 3}
        now = 102
        assert single_release(client, "a", "newer", 1).status_code == 201
        assert single_release(client, "a", "desk", 1).status_code == 200
        older = client.get(history, params={"after_held": first["next_after_held"]}).raise_for_status().json()
        assert older["reservation"]["held"] == 2 and older["next_after_held"] is None
        assert older["releases"] == [
            {"source": "batch", "receipt_id": "desk", "released_at_ms": 100_000,
             "held_before": 6, "quantity": 2, "held_after": 4},
            {"source": "single", "receipt_id": "legacy", "released_at_ms": None,
             "held_before": 7, "quantity": 1, "held_after": 6},
        ]
        now = 105
        expired = client.get(history).raise_for_status().json()
        assert expired["reservation"]["state"] == "expired"
        assert expired["reservation"]["held"] == 0 and expired["reservation"]["returned"] == 7
        assert expired["releases"][1:] == [expected_head, *older["releases"]]
        assert client.get("/reservations/missing/releases").status_code == 404
        for params in ({"limit": 0}, {"limit": 101}, {"after_held": -1}, {"after_held": 2**63}):
            assert client.get(history, params=params).status_code == 422


def test_release_history_waits_for_cross_service_batch_commit(tmp_path, monkeypatch):
    database = tmp_path / "snapshot.db"
    writing, reading, proceed = Event(), Event(), Event()
    connect, record = Store.connect, Store.record_release

    def reader_clock():
        return 101

    def trace_reader(store):
        conn = connect(store)
        if store.clock is reader_clock:
            conn.set_trace_callback(lambda statement: reading.set() if statement == "BEGIN IMMEDIATE" else None)
        return conn

    def pause_first_release(store, conn, row, release_id, quantity, released_at_ms=None):
        result = record(store, conn, row, release_id, quantity, released_at_ms)
        if row["id"] == "a":
            writing.set()
            assert proceed.wait(10)
        return result

    monkeypatch.setattr(Store, "connect", trace_reader)
    monkeypatch.setattr(Store, "record_release", pause_first_release)
    with TestClient(create_app(database, clock=lambda: 100)) as writer, \
            TestClient(create_app(database, clock=reader_clock)) as observer:
        hold(writer, "a", 2)
        hold(writer, "z", 2)
        reading.clear()
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(release, writer, "desk", [item("a", 2, 2), item("z", 2, 1)])
            try:
                assert writing.wait(5)
                history = pool.submit(observer.get, "/reservations/a/releases", params={"limit": 1})
                assert reading.wait(5)
                assert not history.done()
            finally:
                proceed.set()
            assert pending.result(timeout=10).status_code == 201
            snapshot = history.result(timeout=10).raise_for_status().json()
        assert snapshot["captured_at_ms"] == 101_000 and snapshot["reservation"]["held"] == 0
        assert snapshot["next_after_held"] is None
        assert snapshot["releases"] == [{"source": "batch", "receipt_id": "desk", "released_at_ms": 100_000,
                                         "held_before": 2, "quantity": 2, "held_after": 0}]
        assert len(observer.get("/release-batches/desk").json()["items"]) == 2
