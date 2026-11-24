from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "/reservation-batches"


def add_wrapping(database, quantity):
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("INSERT INTO products VALUES ('WRAP-01',?,?)", (quantity, quantity))


def reserve(api, batch_id, items):
    return api.post(ENDPOINT, headers={"Idempotency-Key": batch_id}, json={"items": items})


def inventory(api):
    return [{"sku": row["sku"], "available": row["available"]} for row in api.get("/inventory").json()]


def test_shortage_restock_and_cancellation_match_the_demo(tmp_path):
    fixture = json.loads((ROOT / "examples/reservation-batch-demo.json").read_bytes())
    db = tmp_path / "demo.db"
    clock = lambda: 100
    items = fixture["requested"]
    stages = []
    with TestClient(create_app(db, ttl_seconds=3, clock=clock)) as api:
        add_wrapping(db, 1)

        def capture(stage, response):
            receipt = api.get(ENDPOINT + "/order")
            step = {"stage": stage, "status": response.status_code,
                    "receipt_exists": receipt.status_code == 200, "available": inventory(api)}
            if stage in ("cancelled", "cancellation_replayed"):
                step["released"] = [{key: row[key] for key in ("sku", "quantity_released")}
                                    for row in response.json()["items"]]
            stages.append(step)

        missing = reserve(api, "order", [items[0], {"sku": "ZZ-UNKNOWN", "quantity": 1}])
        assert missing.status_code == 404 and missing.json()["detail"] == "ZZ-UNKNOWN: Unknown SKU"
        shortage = reserve(api, "order", items)
        assert shortage.json()["detail"] == "WRAP-01: Insufficient stock"
        capture("shortage", shortage)
        with closing(sqlite3.connect(db)) as conn:
            assert conn.execute("SELECT count(*) FROM reservations").fetchone()[0] == 0

        Store(db, clock=clock).apply_receipts([(str(uuid4()), "WRAP-01", 1)])
        first = reserve(api, "order", items)
        assert first.headers["Cache-Control"] == "no-store"
        receipt = first.json()
        assert receipt["batch_id"] == "order" and receipt["expires_at_ms"] == 103_000
        assert [{key: row[key] for key in ("sku", "quantity")} for row in receipt["items"]] == items
        assert len({row["id"] for row in receipt["items"]}) == 2
        capture("reserved", first)
        replay = reserve(api, "order", items[::-1])
        assert replay.json() == receipt
        capture("replayed", replay)
        assert reserve(api, "order", [{**items[0], "quantity": 5}, items[1]]).status_code == 409
        assert reserve(api, "order", items[:1]).status_code == 409

        batch = ENDPOINT + "/order"
        kit = f"/reservations/{receipt['items'][0]['id']}"
        assert api.get(batch + "/cancellation").status_code == 404
        assert api.post(kit + "/fulfillments", headers={"Idempotency-Key": "sent"}, json={"quantity": 1}).status_code == 201
        cancelled = api.delete(batch)
        assert cancelled.headers["Cache-Control"] == "no-store"
        capture("cancelled", cancelled)
        cancelled_again = api.delete(batch)
        assert cancelled_again.json() == cancelled.json()
        capture("cancellation_replayed", cancelled_again)
        assert stages == fixture["stages"]
        assert api.get(batch).json() == receipt
        assert api.get(batch + "/cancellation").json() == cancelled.json()
        assert reserve(api, "order", items).json() == receipt
        assert api.get("/inventory").json()[0] == {"sku": "KIT-01", "capacity": 19, "available": 19}
        progress = api.get(kit).json()
        assert (progress["state"], progress["shipped"], progress["held"]) == ("released", 1, 0)


def test_receipt_survives_renewal_expiry_and_restart_and_member_ids_work_with_packing(tmp_path):
    db = tmp_path / "expiry.db"
    items = [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}]
    with TestClient(create_app(db, ttl_seconds=3, clock=lambda: 100)) as api:
        add_wrapping(db, 2)
        response = reserve(api, "batch", items)
        assert response.status_code == 201
        receipt = response.json()
        kit, wrap = [row["id"] for row in receipt["items"]]
        renew = api.post(f"/reservations/{wrap}/renewals", headers={"Idempotency-Key": "more-time"},
                         json={"expected_expires_at_ms": 103_000, "extend_seconds": 10})
        assert renew.status_code == 201
    with TestClient(create_app(db, clock=lambda: 103)) as api:
        fetched = api.get(ENDPOINT + "/batch")
        assert (fetched.status_code, fetched.json()) == (200, receipt)
        assert fetched.headers["Cache-Control"] == "no-store"
        replay = reserve(api, "batch", items[::-1])
        assert (replay.status_code, replay.json()) == (200, receipt)
        report = api.post("/packing-snapshots", json={"reservation_ids": [kit, wrap]})
        assert report.status_code == 200
        rows = [row["reservation"] for row in report.json()["holds"]]
        assert [(row["state"], row["held"], row["expires_at_ms"]) for row in rows] == [
            ("expired", 0, 103_000), ("held", 2, 113_000),
        ]
        assert inventory(api) == [{"sku": "KIT-01", "available": 20}, {"sku": "WRAP-01", "available": 0}]


def test_two_instances_race_for_the_last_units_and_only_one_batch_is_created(tmp_path):
    db = tmp_path / "race.db"
    items = [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}]
    with TestClient(create_app(db)) as left, TestClient(create_app(db)) as right:
        add_wrapping(db, 2)
        gate = Barrier(12, timeout=15)

        def attempt(index):
            batch_id = "east" if index % 2 else "west"
            client = left if index % 3 else right
            gate.wait()
            return batch_id, reserve(client, batch_id, items if index % 4 < 2 else items[::-1])

        with ThreadPoolExecutor(max_workers=12) as pool:
            responses = list(pool.map(attempt, range(12)))
        assert sorted(response.status_code for _, response in responses) == [200] * 5 + [201] + [409] * 6
        winner, first = next((key, response) for key, response in responses if response.status_code == 201)
        assert all(response.json() == first.json() for key, response in responses if key == winner)
        loser = "west" if winner == "east" else "east"
        assert right.get(ENDPOINT + "/" + loser).status_code == 404
        assert inventory(left) == [{"sku": "KIT-01", "available": 16}, {"sku": "WRAP-01", "available": 0}]


def test_batch_preserves_preexisting_holds_and_rejects_invalid_items(tmp_path):
    db = tmp_path / "old.db"
    with closing(sqlite3.connect(db)) as conn:
        conn.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT);
            INSERT INTO products VALUES ('KIT-01',20,3), ('WRAP-01',2,2);
            INSERT INTO reservations VALUES ('old','KIT-01',17,'held');
        """)
    row = {"sku": "KIT-01", "quantity": 1}
    with TestClient(create_app(db)) as api:
        for invalid in ([], [row, row], [{**row, "quantity": True}],
                        [{"sku": f"SKU-{index}", "quantity": 1} for index in range(101)]):
            assert reserve(api, "invalid", invalid).status_code == 422
        assert api.get(ENDPOINT + "/invalid").status_code == 404
        assert reserve(api, "batch", [{**row, "quantity": 4}]).status_code == 409
        assert reserve(api, "batch", [row, {"sku": "WRAP-01", "quantity": 2}]).status_code == 201
        old = api.get("/reservations/old").json()
        assert (old["state"], old["held"], old["expires_at_ms"]) == ("held", 17, None)


def test_cancellation_survives_restart_and_handles_an_older_batch_with_expired_items(tmp_path):
    db = tmp_path / "upgrade-cancel.db"
    items = [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}]
    with TestClient(create_app(db, ttl_seconds=2, clock=lambda: 100)) as api:
        add_wrapping(db, 2)
        receipt = reserve(api, "old-batch", items).json()
        kit, wrap = [row["id"] for row in receipt["items"]]
        assert api.post(f"/reservations/{wrap}/renewals", headers={"Idempotency-Key": "more-time"},
                        json={"expected_expires_at_ms": 102_000, "extend_seconds": 10}).status_code == 201
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("DROP TABLE reservation_batch_cancellations")

    path = ENDPOINT + "/old-batch"
    with TestClient(create_app(db, clock=lambda: 102)) as api:
        result = api.delete(path)
        assert result.status_code == 200
        cancelled = result.json()
        assert cancelled == {"batch_id": "old-batch", "cancelled_at_ms": 102_000, "items": [
            {"id": kit, "sku": "KIT-01", "quantity_released": 0},
            {"id": wrap, "sku": "WRAP-01", "quantity_released": 2},
        ]}
        assert api.get(f"/reservations/{kit}").json()["state"] == "expired"
        assert api.delete(ENDPOINT + "/missing").status_code == 404
    with TestClient(create_app(db, clock=lambda: 200)) as api:
        assert api.get(path).json() == receipt
        assert api.get(path + "/cancellation").json() == api.delete(path).json() == cancelled
        assert inventory(api) == [{"sku": "KIT-01", "available": 20}, {"sku": "WRAP-01", "available": 2}]


def test_cancellation_rolls_back_if_the_last_item_cannot_be_recorded(tmp_path):
    db = tmp_path / "cancel-rollback.db"
    with TestClient(create_app(db)) as api:
        add_wrapping(db, 2)
        items = [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}]
        kit, _ = [row["id"] for row in reserve(api, "order", items).json()["items"]]
        assert api.post(f"/reservations/{kit}/releases", headers={"Idempotency-Key": "reduce"},
                        json={"quantity": 1}).status_code == 201
        before = inventory(api)
        with closing(sqlite3.connect(db)) as conn:
            conn.execute("""CREATE TRIGGER fail_last BEFORE INSERT ON reservation_batch_cancellations
                         WHEN (SELECT sku FROM reservations WHERE id=NEW.reservation_id)='WRAP-01'
                         BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        path = ENDPOINT + "/order"
        with pytest.raises(sqlite3.IntegrityError, match="test failure"):
            api.delete(path)
        assert inventory(api) == before
        assert api.get(f"/reservations/{kit}").json()["held"] == 3
        assert api.get(path + "/cancellation").status_code == 404
        with closing(sqlite3.connect(db)) as conn:
            conn.execute("DROP TRIGGER fail_last")
        assert [row["quantity_released"] for row in api.delete(path).json()["items"]] == [3, 2]


def test_concurrent_dispatch_and_cancellation_have_a_single_consistent_outcome(tmp_path):
    db = tmp_path / "cancel-race.db"
    with TestClient(create_app(db)) as left, TestClient(create_app(db)) as right:
        add_wrapping(db, 2)
        items = [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}]
        kit = reserve(left, "order", items).json()["items"][0]["id"]
        gate = Barrier(12, timeout=15)

        def compete(index):
            gate.wait()
            if index % 2:
                return right.delete(ENDPOINT + "/order")
            return left.post(f"/reservations/{kit}/fulfillments", headers={"Idempotency-Key": "box"},
                             json={"quantity": 1})

        with ThreadPoolExecutor(max_workers=12) as pool:
            responses = list(pool.map(compete, range(12)))
        dispatch_codes = sorted(reply.status_code for reply in responses[::2])
        assert dispatch_codes in ([409] * 6, [200] * 5 + [201])
        shipped = int(201 in dispatch_codes)
        receipts = responses[1::2]
        cancelled = receipts[0].json()
        assert all((reply.status_code, reply.json()) == (200, cancelled) for reply in receipts)
        assert [row["quantity_released"] for row in cancelled["items"]] == [4 - shipped, 2]
        progress = left.get(f"/reservations/{kit}").json()
        assert (progress["shipped"], progress["held"]) == (shipped, 0)
        assert left.get("/inventory").json()[0] == {"sku": "KIT-01", "capacity": 20 - shipped, "available": 20 - shipped}
