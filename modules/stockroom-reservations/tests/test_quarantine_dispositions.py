from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Barrier

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.reconcile import reconcile
from stockroom.store import Store


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


def test_queue_reads_open_balances_by_sku_and_pages_past_a_resolved_old_batch(tmp_path):
    database = tmp_path / "stockroom.db"
    clock = [100.0]
    def app():
        return create_app(database, clock=lambda: clock[0])

    def add(api, order, count, sku="KIT-01"):
        assert post(api, "/reservations", order, {"sku": sku, "quantity": count}).status_code == 201
        assert post(api, f"/reservations/{order}/fulfillments", "box", {"quantity": count}).status_code == 201
        return {"reservation_id": order, "shipment_id": "box", "sellable": 0, "quarantined": count}

    def queue(api, **params):
        reply = api.get("/quarantine-queue", params=params)
        assert (reply.status_code, reply.headers["Cache-Control"]) == (200, "no-store")
        return reply.json()

    with TestClient(app()) as api:
        legacy = add(api, "legacy", 2)
        original = post(api, "/return-inspections", "legacy-dock", {"boxes": [legacy]}).json()
    with closing(sqlite3.connect(database)) as conn, conn:
        conn.execute("ALTER TABLE return_inspection_boxes DROP COLUMN received_at_ms")
        conn.execute("INSERT INTO products VALUES ('WRAP-01',5,5)")
    with TestClient(app()) as api:
        clock[0] = 101.0
        rows = [add(api, "recent-kit", 3), add(api, "recent-wrap", 2, "WRAP-01")]
        assert post(api, "/return-inspections", "a-recent-dock", {"boxes": rows}).status_code == 201
        assert post(api, "/return-inspections", "b-recent-dock", {"boxes": [add(api, "other", 1)]}).status_code == 201
        clock[0] = 120.0
        assert post(api, "/return-inspections", "legacy-dock", {"boxes": [legacy]}).json() == original
        first = queue(api, limit=1)
        assert first == {
            "captured_at_ms": 120000, "sku": None, "summary": {"batches": 3, "boxes": 4, "units": 8},
            "batches": [{"batch_id": "legacy-dock", "received_at_ms": None, "pending_boxes": 1, "pending_units": 2}],
            "next": {"after_received_at_ms": -1, "after_batch_id": "legacy-dock"},
        }
        assert post(api, "/return-inspections/legacy-dock/dispositions", "clear", {
            "boxes": [decision("legacy", 2, 0, 2)],
        }).status_code == 201
        second = queue(api, limit=1, **first["next"])
        assert second["summary"] == {"batches": 2, "boxes": 3, "units": 6}
        assert second["batches"] == [{"batch_id": "a-recent-dock", "received_at_ms": 101000,
                                      "pending_boxes": 2, "pending_units": 5}]
        assert second["next"] == {"after_received_at_ms": 101000, "after_batch_id": "a-recent-dock"}
        assert queue(api, limit=1, **second["next"])["batches"][0]["batch_id"] == "b-recent-dock"
        assert queue(api, sku="WRAP-01")["summary"] == {"batches": 1, "boxes": 1, "units": 2}
        assert post(api, "/return-inspections/a-recent-dock/dispositions", "partial", {
            "boxes": [decision("recent-wrap", 1, 0, 2)],
        }).status_code == 201
        assert queue(api, sku="WRAP-01")["batches"][0]["pending_units"] == 1
        assert queue(api, sku="NONE")["summary"] == {"batches": 0, "boxes": 0, "units": 0}
        past_end = queue(api, after_batch_id="b-recent-dock", after_received_at_ms=101000)
        assert past_end["batches"] == [] and past_end["summary"] == {"batches": 2, "boxes": 3, "units": 5}
        assert api.get("/quarantine-queue?after_batch_id=legacy-dock").status_code == 422
        assert api.get("/quarantine-queue?limit=101").status_code == 422


def test_inspection_history_preserves_original_receipt_filters_box_and_pages_by_tied_timestamp(tmp_path):
    database = tmp_path / "stockroom.db"
    clock = [100.0]
    with TestClient(create_app(database, clock=lambda: clock[0])) as api:
        original = []
        for order, sellable, quarantined in (("east", 1, 3), ("west", 0, 2), ("dry", 2, 0)):
            quantity = sellable + quarantined
            assert post(api, "/reservations", order, {"sku": "KIT-01", "quantity": quantity}).status_code == 201
            assert post(api, f"/reservations/{order}/fulfillments", "box", {"quantity": quantity}).status_code == 201
            original.append({"reservation_id": order, "shipment_id": "box", "sellable": sellable, "quarantined": quarantined})
        receipt = post(api, "/return-inspections", "inspection", {"boxes": original}).json()
        path = "/return-inspections/inspection/history"
        baseline = api.get(path)
        assert (baseline.status_code, baseline.headers["Cache-Control"]) == (200, "no-store")
        assert baseline.json()["summary"] == {"sellable": 3, "quarantined": 5, "restocked": 0, "discarded": 0, "remaining": 5}
        assert baseline.json()["received_at_ms"] == 100000 and not baseline.json()["dispositions"]
        clock[0] = 101.0
        first = confirm(api, "z-pass", [decision("east", 1, 0, 3), decision("west", 0, 1, 2)]).json()
        second = confirm(api, "a-pass", [decision("east", 0, 1, 2), decision("west", 1, 0, 1)]).json()
        recent = api.get(path, params={"limit": 1}).json()
        assert recent["dispositions"] == [{"disposition_id": "z-pass", "recorded_at_ms": 101000, "boxes": first["boxes"]}]
        assert recent["summary"] == {"sellable": 3, "quarantined": 5, "restocked": 2, "discarded": 2, "remaining": 1}
        assert recent["next"] == {"before_recorded_at_ms": 101000, "before_disposition_id": "z-pass"}
        clock[0] = 102.0
        assert confirm(api, "closing", [decision("east", 1, 0, 1)]).status_code == 201
        older = api.get(path, params={"limit": 1, **recent["next"]}).json()
        assert older["dispositions"] == [{"disposition_id": "a-pass", "recorded_at_ms": 101000, "boxes": second["boxes"]}]
        assert older["next"] is None and older["summary"]["remaining"] == 0 and older["captured_at_ms"] == 102000
        east = api.get(path, params={"reservation_id": "east", "shipment_id": "box"}).json()
        assert east["box_filter"] == {"reservation_id": "east", "shipment_id": "box"}
        assert [entry["disposition_id"] for entry in east["dispositions"]] == ["closing", "z-pass", "a-pass"]
        assert all([box["reservation_id"] for box in entry["boxes"]] == ["east"] for entry in east["dispositions"])
        assert east["boxes"] == older["boxes"] and east["summary"] == older["summary"]
        assert not api.get(path, params={"reservation_id": "dry", "shipment_id": "box"}).json()["dispositions"]
        assert api.get(path, params={"reservation_id": "dry"}).status_code == 422
        assert api.get(path, params={"before_disposition_id": "a-pass"}).status_code == 422
        assert api.get(path, params={"reservation_id": "dry", "shipment_id": "unknown"}).status_code == 404
        assert api.get("/return-inspections/not-found/history").status_code == 404
        assert api.get("/return-inspections/inspection").json() == receipt
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute("UPDATE return_inspection_boxes SET received_at_ms=NULL")
        assert api.get(path).json()["received_at_ms"] is None


def test_inspection_history_balances_and_operations_share_a_read_snapshot(tmp_path, monkeypatch):
    database = tmp_path / "stockroom.db"
    with TestClient(create_app(database)) as api:
        inspect(api, [("east", 2), ("west", 1)])
        reader = Store(database)
        original = reader.quarantine_balances

        def concurrent_write(conn, batch_id):
            assert confirm(api, "new-review", [decision("east", 1, 0, 2)]).status_code == 201
            return original(conn, batch_id)

        with monkeypatch.context() as patch:
            patch.setattr(reader, "quarantine_balances", concurrent_write)
            before = reader.return_inspection_history("inspection", None, 20, None)
        assert before["summary"]["remaining"] == 3 and before["dispositions"] == []
        after = reader.return_inspection_history("inspection", None, 20, None)
        assert after["summary"]["remaining"] == 2 and after["dispositions"][0]["disposition_id"] == "new-review"


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
