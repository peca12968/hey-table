from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Event

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


def hold(client, reservation, units):
    response = client.post(
        "/reservations",
        headers={"Idempotency-Key": reservation},
        json={"sku": "KIT-01", "quantity": units},
    )
    assert response.status_code == 201


def snapshot(client, *keys):
    return client.post("/packing-snapshots", json={"reservation_ids": list(keys)})


def send_boxes(client, key, **boxes):
    return client.post(
        "/dispatch-batches",
        headers={"Idempotency-Key": key},
        json={
            "boxes": [
                {"reservation_id": reservation, "shipment_id": "box", "quantity": qty}
                for reservation, qty in boxes.items()
            ]
        },
    )


def test_same_deadline_for_all_orders_and_legacy_schema(tmp_path):
    path = tmp_path / "legacy.db"
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT);
            INSERT INTO products VALUES ('KIT-01',20,15), ('OTHER',4,2);
            INSERT INTO reservations VALUES ('old','KIT-01',5,'held'), ('other','OTHER',2,'held');
        """)
    now = [80]
    with TestClient(create_app(path, ttl_seconds=2, clock=lambda: now[0])) as api:
        hold(api, "east", 3)
        hold(api, "west", 4)
        assert send_boxes(api, "van", east=2, west=1).status_code == 201
        restock = api.post(
            "/reservations/east/fulfillments/box/returns",
            headers={"Idempotency-Key": "return"},
            json={"quantity": 1},
        )
        assert restock.status_code == 201
        now[0] = 82
        response = snapshot(api, "west", "east", "old", "other")
        assert (
            response.status_code == 200
            and response.headers["Cache-Control"] == "no-store"
        )
        body = response.json()
        assert body["captured_at_ms"] == 82000
        assert body["products"] == [
            {"sku": "KIT-01", "capacity": 18, "available": 13},
            {"sku": "OTHER", "capacity": 4, "available": 2},
        ]
        assert [
            (
                row["reservation"]["id"],
                row["reservation"]["state"],
                row["reservation"]["held"],
                row["restocked"],
            )
            for row in body["holds"]
        ] == [
            ("west", "expired", 0, 0),
            ("east", "expired", 0, 1),
            ("old", "held", 5, 0),
            ("other", "held", 2, 0),
        ]
        assert body["holds"][2]["reservation"]["expires_at_ms"] is None
        assert api.get("/reservations/east/fulfillments").json() == body["holds"][1]


def test_snapshot_never_spans_a_concurrent_multi_order_commit(tmp_path, monkeypatch):
    path = tmp_path / "race.db"
    reading, release, attempting = Event(), Event(), Event()
    balance_query, open_connection = Store.shipment_balances, Store.connect

    def writer_clock():
        return 102

    def connect(store):
        db = open_connection(store)
        if store.clock is writer_clock:

            def mark_commit_attempt(query):
                if reading.is_set() and query == "BEGIN IMMEDIATE":
                    attempting.set()

            db.set_trace_callback(mark_commit_attempt)
        return db

    def wait_then_read(db, keys, shipment_id=None):
        if len(keys) == 2:
            reading.set()
            assert release.wait(10)
        yield from balance_query(db, keys, shipment_id)

    monkeypatch.setattr(Store, "connect", connect)
    monkeypatch.setattr(Store, "shipment_balances", staticmethod(wait_then_read))
    with (
        TestClient(create_app(path, clock=lambda: 100)) as reader,
        TestClient(create_app(path, clock=writer_clock)) as writer,
    ):
        hold(reader, "east", 4)
        hold(reader, "west", 5)
        with ThreadPoolExecutor(max_workers=2) as pool:
            captured = pool.submit(snapshot, reader, "east", "west")
            try:
                assert reading.wait(5)
                dispatch = pool.submit(send_boxes, writer, "van", east=3, west=2)
                assert attempting.wait(5)
                assert not dispatch.done()
            finally:
                release.set()
            before = captured.result(timeout=10)
            assert dispatch.result(timeout=10).status_code == 201
        after = snapshot(writer, "east", "west")
    assert before.status_code == after.status_code == 200
    for response, at, capacity, held, boxes in [
        (before, 100000, 20, [4, 5], [0, 0]),
        (after, 102000, 15, [1, 3], [1, 1]),
    ]:
        body = response.json()
        assert body["captured_at_ms"] == at
        assert body["products"][0]["capacity"] == capacity
        assert [row["reservation"]["held"] for row in body["holds"]] == held
        assert [len(row["boxes"]) for row in body["holds"]] == boxes


def test_unknown_or_invalid_keys_never_return_partial_snapshot(tmp_path):
    path = tmp_path / "unknown.db"
    now = [0]
    with TestClient(create_app(path, ttl_seconds=1, clock=lambda: now[0])) as api:
        hold(api, "first", 1)
        now[0] = 1
        for keys in [
            (),
            ("first", "first"),
            ("invalid/key",),
            tuple(str(n) for n in range(101)),
        ]:
            assert snapshot(api, *keys).status_code == 422
        absent = snapshot(api, "first", "missing", "also-missing")
        assert absent.status_code == 404
        assert absent.json() == {
            "detail": "Unknown reservations: missing, also-missing"
        }
        with closing(sqlite3.connect(path)) as db:
            assert db.execute(
                "SELECT available FROM products WHERE sku='KIT-01'"
            ).fetchone() == (19,)
        assert snapshot(api, "first").json()["products"][0]["available"] == 20
