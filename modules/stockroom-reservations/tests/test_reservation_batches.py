from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from threading import Barrier
from uuid import uuid4

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


def test_shortage_rolls_back_and_receipt_matches_the_demo_after_restock(tmp_path):
    fixture = json.loads((ROOT / "examples/reservation-batch-demo.json").read_bytes())
    db = tmp_path / "demo.db"
    clock = lambda: 100
    items = fixture["requested"]
    stages = []
    with TestClient(create_app(db, ttl_seconds=3, clock=clock)) as api:
        add_wrapping(db, 1)

        def capture(stage, response):
            receipt = api.get(ENDPOINT + "/order")
            stages.append({"stage": stage, "status": response.status_code,
                           "receipt_exists": receipt.status_code == 200, "available": inventory(api)})

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
        assert stages == fixture["stages"]
        assert reserve(api, "order", [{**items[0], "quantity": 5}, items[1]]).status_code == 409
        assert reserve(api, "order", items[:1]).status_code == 409


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
