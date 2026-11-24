from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Barrier

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.reconcile import reconcile


def post(api, path, key, payload):
    return api.post(path, headers={"Idempotency-Key": key}, json=payload)


def shipped(api, order, units):
    assert (
        post(
            api, "/reservations", order, {"sku": "KIT-01", "quantity": units}
        ).status_code
        == 201
    )
    assert (
        post(
            api, f"/reservations/{order}/fulfillments", "box", {"quantity": units}
        ).status_code
        == 201
    )


def box(order, units, shipment="box"):
    return {"reservation_id": order, "shipment_id": shipment, "quantity": units}


def batch(api, key, boxes):
    return post(api, "/return-batches", key, {"boxes": boxes})


def return_to(api, key, order, units):
    return post(
        api, f"/reservations/{order}/fulfillments/box/returns", key, {"quantity": units}
    )


def test_original_receipt_survives_restart_and_another_return(tmp_path):
    database = tmp_path / "inventory.db"
    opening = tmp_path / "before.db"
    with TestClient(create_app(database)) as api:
        shipped(api, "east", 3)
        shipped(api, "west", 2)
        with (
            closing(sqlite3.connect(database)) as source,
            closing(sqlite3.connect(opening)) as target,
        ):
            source.backup(target)
        boxes = [box("west", 2), box("east", 1)]
        original = batch(api, "inspection", boxes)
        assert original.status_code == 201
    with TestClient(create_app(database)) as restarted:
        assert return_to(restarted, "later", "east", 2).status_code == 201
        saved = restarted.get("/return-batches/inspection")
        assert saved.status_code == 200
        receipt = {
            "batch_id": "inspection",
            "boxes": [
                dict(boxes[1], return_id="inspection", returnable_after=2),
                dict(boxes[0], return_id="inspection", returnable_after=0),
            ],
        }
        assert saved.json() == original.json() == receipt
        replay = batch(restarted, "inspection", boxes[::-1])
        assert (replay.status_code, replay.json()) == (200, receipt)
        assert batch(restarted, "inspection", boxes[:1]).status_code == 409
        single = return_to(restarted, "inspection", "east", 1)
        assert (single.status_code, single.json()) == (200, receipt["boxes"][0])
    report = reconcile(opening, database, "KIT-01")
    assert report["balanced"] and report["new_units"]["restock"] == 5
    assert report["closing"] == {"capacity": 20, "available": 20, "held": 0}


def test_failure_on_last_box_rolls_back_prior_updates_and_does_not_consume_key(
    tmp_path,
):
    database = tmp_path / "inventory.db"
    with TestClient(create_app(database), raise_server_exceptions=False) as api:
        shipped(api, "first", 2)
        shipped(api, "last", 1)
        good = [box("first", 2), box("last", 1)]
        for bad, status in ((box("last", 2), 409), (box("zzz", 1), 404)):
            response = batch(api, "inspection", [good[0], bad])
            assert response.status_code == status
            assert response.json()["detail"].startswith(f"{bad['reservation_id']}/box:")
        with closing(sqlite3.connect(database)) as db:
            db.execute("""CREATE TRIGGER simulate_write_error BEFORE INSERT ON return_batch_boxes
                          WHEN NEW.reservation_id='last'
                          BEGIN SELECT RAISE(ABORT, 'test write failure'); END""")
        assert batch(api, "inspection", good).status_code == 500
        assert api.get("/return-batches/inspection").status_code == 404
        assert api.get("/reservations/first/fulfillments/box").json()["restocked"] == 0
        assert api.get("/inventory").json()[0] == {
            "sku": "KIT-01",
            "capacity": 17,
            "available": 17,
        }
        with closing(sqlite3.connect(database)) as db:
            db.execute("DROP TRIGGER simulate_write_error")
        assert batch(api, "inspection", good).status_code == 201


def test_old_receipts_remain_readable_and_cannot_be_adopted_by_a_batch(tmp_path):
    database = tmp_path / "old.db"
    with TestClient(create_app(database)) as api:
        shipped(api, "old", 3)
        original = return_to(api, "older", "old", 1)
        assert original.status_code == 201
    with closing(sqlite3.connect(database)) as db:
        db.execute("DROP TABLE return_batch_boxes")
    with TestClient(create_app(database)) as restarted:
        single = return_to(restarted, "older", "old", 1)
        assert (single.status_code, single.json()) == (200, original.json())
        assert batch(restarted, "older", [box("old", 1)]).status_code == 409
        assert restarted.get("/return-batches/older").status_code == 404
        for invalid in ([], [box("old", 1)] * 2, [box("old", True)], [box("old", 0)]):
            assert batch(restarted, "new", invalid).status_code == 422
        assert batch(restarted, "new", [box("old", 2)]).status_code == 201


def test_two_services_race_two_batches_and_a_single_return(tmp_path):
    database = tmp_path / "race.db"
    with (
        TestClient(create_app(database)) as left,
        TestClient(create_app(database)) as right,
    ):
        for key in ("east", "west", "shared"):
            shipped(left, key, 2)
        gate = Barrier(12, timeout=15)

        def attempt(index):
            api = left if index % 2 else right
            key = ("east", "west", "single")[index % 3]
            gate.wait()
            if key == "single":
                return key, return_to(api, key, "shared", 2)
            boxes = [box(key, 1), box("shared", 2)]
            return key, batch(api, key, boxes if index % 2 else boxes[::-1])

        with ThreadPoolExecutor(max_workers=12) as pool:
            replies = list(pool.map(attempt, range(12)))
        assert (
            sorted(reply.status_code for _, reply in replies)
            == [200] * 3 + [201] + [409] * 8
        )
        winner, original = next(
            (key, reply.json()) for key, reply in replies if reply.status_code == 201
        )
        assert all(reply.json() == original for key, reply in replies if key == winner)
        for key in ("east", "west"):
            status = 200 if key == winner else 404
            assert right.get(f"/return-batches/{key}").status_code == status
            assert right.get(f"/reservations/{key}/fulfillments/box").json()[
                "restocked"
            ] == int(key == winner)
        final = 16 if winner == "single" else 17
        assert right.get("/inventory").json()[0] == {
            "sku": "KIT-01",
            "capacity": final,
            "available": final,
        }


def test_return_batch_cannot_cross_sqlite_integer_capacity(tmp_path):
    database = tmp_path / "boundary.db"
    maximum = 2**63 - 1
    with TestClient(create_app(database)) as api:
        shipped(api, "first", 1)
        shipped(api, "last", 1)
        with closing(sqlite3.connect(database)) as db, db:
            db.execute(
                "UPDATE products SET capacity=?, available=?",
                (maximum - 1, maximum - 1),
            )
        response = batch(api, "inspection", [box("first", 1), box("last", 1)])
        assert response.status_code == 409
        assert "last/box:" in response.json()["detail"]
        assert api.get("/return-batches/inspection").status_code == 404
        assert api.get("/inventory").json()[0]["capacity"] == maximum - 1
        assert batch(api, "inspection", [box("first", 1)]).status_code == 201
        assert api.get("/inventory").json()[0]["capacity"] == maximum
