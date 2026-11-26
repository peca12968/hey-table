from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Barrier

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.reconcile import reconcile


def post(api, path, key, body):
    return api.post(path, headers={"Idempotency-Key": key}, json=body)


def inspect(api, orders):
    boxes = []
    for reservation, quantity in orders:
        assert post(api, "/reservations", reservation, {"sku": "KIT-01", "quantity": quantity}).status_code == 201
        assert post(api, f"/reservations/{reservation}/fulfillments", "box", {"quantity": quantity}).status_code == 201
        boxes.append({"reservation_id": reservation, "shipment_id": "box", "sellable": 0, "quarantined": quantity})
    assert post(api, "/return-inspections", "inspection", {"boxes": boxes}).status_code == 201


def decision(reservation, restock, discard, expected, reason="second inspection"):
    return {"reservation_id": reservation, "shipment_id": "box", "restock": restock, "discard": discard,
            "expected_remaining": expected, "reason": reason}


def confirm(api, key, boxes):
    return post(api, "/return-inspections/inspection/dispositions", key, {"boxes": boxes})


def quarantine(api):
    response = api.get("/return-inspections/inspection/quarantine")
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    return response.json()["boxes"]


def test_partial_decisions_preserve_original_receipts_and_reconcile_saleable_inventory(tmp_path):
    database, opening = tmp_path / "stockroom.db", tmp_path / "before.db"
    with TestClient(create_app(database)) as api:
        inspect(api, [("east", 3), ("west", 2)])
        original = api.get("/return-inspections/inspection").json()
        with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(opening)) as target:
            source.execute("DROP TABLE return_quarantine_dispositions")
            source.backup(target)
    with TestClient(create_app(database)) as api:
        assert [box["remaining"] for box in quarantine(api)] == [3, 2]
        first = [decision("west", 0, 1, 2), decision("east", 1, 0, 3)]
        result = confirm(api, "early", first)
        assert result.status_code == 201 and result.headers["Cache-Control"] == "no-store"
        receipt = result.json()
        assert [row["remaining_after"] for row in receipt["boxes"]] == [2, 1]
        assert api.get("/inventory").json()[0]["available"] == 16
        assert [box["remaining"] for box in quarantine(api)] == [2, 1]
        assert confirm(api, "late", [decision("east", 0, 2, 2), decision("west", 1, 0, 1)]).status_code == 201
        assert api.get("/inventory").json()[0]["available"] == 17
        assert confirm(api, "early", [dict(first[0], reason="changed reason"), first[1]]).status_code == 409
        assert api.get("/return-inspections/inspection").json() == original
    with TestClient(create_app(database)) as api:
        saved = api.get("/return-inspections/inspection/dispositions/early")
        assert saved.status_code == 200 and saved.json() == receipt
        replay = confirm(api, "early", list(reversed(first)))
        assert replay.status_code == 200 and replay.json() == receipt
        assert [row["remaining"] for row in quarantine(api)] == [0, 0]
        for reservation, discarded in [("east", 2), ("west", 1)]:
            box = api.get(f"/reservations/{reservation}/fulfillments/box").json()
            assert box["returnable"] == 0 and box["restocked"] == 1 and box["discarded"] == discarded
            assert "quarantined" not in box
    audit = reconcile(opening, database, "KIT-01")
    assert audit["balanced"] and audit["new_units"]["restock"] == 2
    assert audit["new_units"]["discard"] == 3 and audit["new_units"]["quarantine"] == 0


def test_stale_balance_and_write_failure_roll_back_the_whole_disposition(tmp_path):
    database = tmp_path / "stockroom.db"
    with TestClient(create_app(database), raise_server_exceptions=False) as api:
        inspect(api, [("east", 2), ("west", 2)])
        before = quarantine(api)
        stock = api.get("/inventory").json()
        good = [decision("east", 1, 0, 2), decision("west", 0, 1, 2)]
        for boxes, status in (([good[0], decision("west", 0, 1, 1)], 409),
                              ([good[0], decision("zzz", 0, 1, 1)], 404),
                              ([good[0], good[0]], 422),
                              ([dict(good[0], reason="  ")], 422),
                              ([dict(good[0], discard=2)], 422)):
            assert confirm(api, "failing", boxes).status_code == status
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute("""CREATE TRIGGER fail_disposition BEFORE INSERT ON return_quarantine_dispositions
                WHEN NEW.reservation_id='west' BEGIN SELECT RAISE(ABORT,'test failure'); END""")
        assert confirm(api, "failing", good).status_code == 500
        assert api.get("/return-inspections/inspection/dispositions/failing").status_code == 404
        assert quarantine(api) == before and api.get("/inventory").json() == stock
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute("DROP TRIGGER fail_disposition")
        assert confirm(api, "failing", good).status_code == 201


def test_concurrent_staff_must_recheck_the_remaining_balance(tmp_path):
    database = tmp_path / "stockroom.db"
    with TestClient(create_app(database)) as left, TestClient(create_app(database)) as right:
        inspect(left, [("east", 2)])
        gate = Barrier(2, timeout=10)

        def run(index):
            api, key, box = (left, "restore", decision("east", 1, 0, 2)) if index == 0 else (
                right, "discard", decision("east", 0, 1, 2))
            gate.wait()
            return confirm(api, key, [box]).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            restored, discarded = pool.map(run, range(2))
        assert sorted([restored, discarded]) == [201, 409]
        [balance] = quarantine(right)
        assert balance["remaining"] == 1
        assert balance["restocked"] == int(restored == 201) and balance["discarded"] == int(discarded == 201)
        second = confirm(right, "finish", [decision("east", 0, 1, 1)])
        assert second.status_code == 201 and quarantine(right)[0]["remaining"] == 0
