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
    assert post(api, "/reservations", order, {"sku": "KIT-01", "quantity": units}).status_code == 201
    assert post(api, f"/reservations/{order}/fulfillments", "box", {"quantity": units}).status_code == 201


def box(order, sellable, quarantined):
    return {"reservation_id": order, "shipment_id": "box", "sellable": sellable, "quarantined": quarantined}


def inspect(api, key, boxes):
    return post(api, "/return-inspections", key, {"boxes": boxes})


def shipment(api, order):
    return api.get(f"/reservations/{order}/fulfillments/box").json()


def test_return_preview_checks_original_label_and_current_balance_without_writing(tmp_path):
    with TestClient(create_app(tmp_path / "stockroom.db")) as api:
        shipped(api, "east", 3)
        shipped(api, "west", 2)
        assert inspect(api, "earlier", [box("east", 0, 1)]).status_code == 201
        before = api.get("/inventory").json()
        east = dict(box("east", 1, 1), label_quantity=3)
        west = dict(box("west", 1, 0), label_quantity=2)

        def preview(*rows):
            return api.post("/return-inspections/preview", json={"boxes": rows})

        ready = preview(west, east)
        assert (ready.status_code, ready.headers["Cache-Control"]) == (200, "no-store")
        assert ready.json() == {"can_receive": True, "boxes": [
            dict(west, sku="KIT-01", dispatched=2, returnable=2, status="ready"),
            dict(east, sku="KIT-01", dispatched=3, returnable=2, status="ready"),
        ]}
        blocked = preview(dict(west, label_quantity=1), dict(east, quarantined=2),
                          dict(east, shipment_id="unshipped"))
        assert blocked.status_code == 200 and not blocked.json()["can_receive"]
        assert [row["status"] for row in blocked.json()["boxes"]] == [
            "label_mismatch", "insufficient_returnable", "unknown_shipment",
        ]
        assert blocked.json()["boxes"][2]["returnable"] is None
        assert preview(east, east).status_code == 422
        assert preview(dict(east, label_quantity=True)).status_code == 422
        assert api.get("/return-inspections/preview").status_code == 404
        assert api.get("/inventory").json() == before
        assert shipment(api, "east")["returnable"] == 2
        assert shipment(api, "west")["returnable"] == 2


def test_legacy_receipt_upgrade_mixed_inspection_and_audit(tmp_path):
    database, opening = tmp_path / "stockroom.db", tmp_path / "before.db"
    with TestClient(create_app(database)) as api:
        shipped(api, "east", 3)
        shipped(api, "west", 2)
        original = post(api, "/reservations/east/fulfillments/box/returns", "old", {"quantity": 1})
        assert original.status_code == 201
        assert "quarantined" not in shipment(api, "east")
    with closing(sqlite3.connect(database)) as source, closing(sqlite3.connect(opening)) as target:
        source.execute("DROP TABLE return_inspection_boxes")
        source.backup(target)
    with TestClient(create_app(database)) as api:
        batch = [box("west", 0, 2), box("east", 1, 1)]
        reply = inspect(api, "dock", batch)
        assert (reply.status_code, reply.headers["Cache-Control"]) == (201, "no-store")
        receipt = {"batch_id": "dock", "boxes": [dict(row, returnable_after=0) for row in reversed(batch)]}
        assert reply.json() == receipt
        assert api.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 17, "available": 17}]
        assert shipment(api, "east") == {
            "reservation_id": "east", "shipment_id": "box", "sku": "KIT-01",
            "dispatched": 3, "restocked": 2, "quarantined": 1, "returnable": 0,
        }
        assert shipment(api, "west")["restocked"] == 0 and shipment(api, "west")["quarantined"] == 2
        statements = api.post("/packing-snapshots", json={"reservation_ids": ["east", "west"]}).json()["holds"]
        assert [(row["restocked"], row["quarantined"], row["returnable"]) for row in statements] == [(2, 1, 0), (0, 2, 0)]
        assert post(api, "/reservations/east/fulfillments/box/returns", "another", {"quantity": 1}).status_code == 409
        assert post(api, "/return-batches", "legacy-late", {"boxes": [
            {"reservation_id": "west", "shipment_id": "box", "quantity": 1}
        ]}).status_code == 409
        replay = post(api, "/reservations/east/fulfillments/box/returns", "old", {"quantity": 1})
        assert (replay.status_code, replay.json()) == (200, original.json())
        assert inspect(api, "dock", [box("east", 2, 0), batch[0]]).status_code == 409
    with TestClient(create_app(database)) as api:
        recovered = api.get("/return-inspections/dock")
        assert (recovered.status_code, recovered.json()) == (200, receipt)
        replay = inspect(api, "dock", list(reversed(batch)))
        assert (replay.status_code, replay.json()) == (200, receipt)
    report = reconcile(opening, database, "KIT-01")
    assert report["balanced"] and report["new_units"]["restock"] == 1
    assert report["new_units"]["quarantine"] == 3


def test_any_invalid_box_or_insert_failure_keeps_both_stock_counts_unchanged(tmp_path):
    database = tmp_path / "stockroom.db"
    with TestClient(create_app(database), raise_server_exceptions=False) as api:
        for order in ("first", "last"):
            shipped(api, order, 2)
        safe = [box("first", 1, 1), box("last", 0, 2)]
        for boxes, status in (([safe[0], box("last", 1, 2)], 409), ([safe[0], box("missing", 0, 1)], 404),
                              ([box("first", 0, 0)], 422), ([box("first", True, 0)], 422), ([safe[0]] * 2, 422)):
            assert inspect(api, "dock", boxes).status_code == status
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute("""CREATE TRIGGER inspection_fault BEFORE INSERT ON return_inspection_boxes
                            WHEN NEW.reservation_id='last'
                            BEGIN SELECT RAISE(ABORT, 'test insert failure'); END""")
        assert inspect(api, "dock", safe).status_code == 500
        assert api.get("/return-inspections/dock").status_code == 404
        assert "quarantined" not in shipment(api, "first")
        assert api.get("/inventory").json()[0]["available"] == 16
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute("DROP TRIGGER inspection_fault")
        assert inspect(api, "dock", safe).status_code == 201
        assert api.get("/inventory").json()[0]["available"] == 17


def test_inspection_and_ordinary_return_race_for_same_remaining_units(tmp_path):
    database = tmp_path / "stockroom.db"
    with TestClient(create_app(database)) as left, TestClient(create_app(database)) as right:
        shipped(left, "east", 2)
        gate = Barrier(2, timeout=10)

        def run(index):
            gate.wait()
            if index == 0:
                return inspect(left, "inspection", [box("east", 0, 2)]).status_code
            return post(right, "/reservations/east/fulfillments/box/returns", "ordinary", {"quantity": 2}).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            inspection, ordinary = pool.map(run, range(2))
        assert sorted([inspection, ordinary]) == [201, 409]
        balance = shipment(right, "east")
        assert balance["returnable"] == 0
        assert balance["restocked"] == (2 if ordinary == 201 else 0)
        assert balance.get("quarantined", 0) == (2 if inspection == 201 else 0)
