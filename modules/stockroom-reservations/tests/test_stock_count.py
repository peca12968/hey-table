from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime
import sqlite3
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.reconcile import reconcile
from stockroom.store import Store


PRODUCT = "/inventory/KIT-01"
BASIS = PRODUCT + "/count-basis"
ADJUSTMENTS = PRODUCT + "/count-adjustments"
BATCH = "/stock-count-batches"


def adjust(client, key, revision, counted, reason="Final recount"):
    return client.post(ADJUSTMENTS, headers={"Idempotency-Key": key}, json={
        "expected_revision": revision, "counted": counted, "count_session": "shift-count", "reason": reason,
    })


def hold(client, units):
    return client.post("/reservations", headers={"Idempotency-Key": "cart"},
                       json={"sku": "KIT-01", "quantity": units}).raise_for_status().json()


def test_count_preserves_confirmed_holds_and_replays_original_receipt(tmp_path):
    now = 100
    path = tmp_path / "live.db"
    opening = tmp_path / "opening.db"
    with TestClient(create_app(path, ttl_seconds=5, clock=lambda: now)) as client:
        assert client.get(BASIS).json()["revision"] == 0
        hold(client, 6)
        with closing(sqlite3.connect(path)) as live, closing(sqlite3.connect(opening)) as saved:
            live.backup(saved)
        basis = client.get(BASIS)
        assert basis.headers["Cache-Control"] == "no-store"
        assert basis.json() == {"sku": "KIT-01", "capacity": 20, "available": 14,
                                "captured_at_ms": 100_000, "held": 6, "revision": 0}
        assert adjust(client, "correct", 0, 5).status_code == 409
        assert client.get(ADJUSTMENTS + "/correct").status_code == 404
        response = adjust(client, "correct", 0, 18, "複點確認短少兩件")
        receipt = response.json()
        assert response.status_code == 201
        assert receipt == {"id": "correct", "sku": "KIT-01", "recorded_at_ms": 100_000, "count_session": "shift-count",
                           "reason": "複點確認短少兩件", "previous_revision": 0, "revision": 1,
                           "previous_capacity": 20, "previous_available": 14, "counted": 18, "available": 12}
        assert client.get("/reservations/cart").json()["held"] == 6
        assert client.get("/inventory/WRAP-01/count-adjustments/correct").status_code == 404
        report = reconcile(opening, path, "KIT-01")
        assert report["balanced"]
        assert report["new_receipts"] == [{"kind": "count_adjustment", "ids": ["correct"], "quantity": -2}]
        assert report["available_changes"]["count_adjustment"] == -2
        assert report["expected_capacity"] == 18

    now = 105
    with TestClient(create_app(path, clock=lambda: now)) as restarted:
        assert restarted.get(BASIS).json() == {"sku": "KIT-01", "capacity": 18, "available": 18,
                                               "captured_at_ms": 105_000, "held": 0, "revision": 1}
        replay = adjust(restarted, "correct", 0, 18, "複點確認短少兩件")
        assert (replay.status_code, replay.json()) == (200, receipt)
        assert restarted.get(ADJUSTMENTS + "/correct").json() == receipt
        assert adjust(restarted, "correct", 0, 18, "Different audit reason").status_code == 409
        unchanged = adjust(restarted, "confirm", 1, 18).raise_for_status().json()
        assert unchanged["previous_revision"] == unchanged["revision"] == 1
        assert adjust(restarted, "empty", 1, 0).raise_for_status().json()["available"] == 0


def test_count_revision_detects_net_zero_movement_and_serializes_two_corrections(tmp_path):
    path = tmp_path / "race.db"
    with TestClient(create_app(path)) as left, TestClient(create_app(path)) as right:
        hold(left, 6)
        start = left.get(BASIS).json()
        assert left.post("/reservations/cart/fulfillments", headers={"Idempotency-Key": "box"},
                         json={"quantity": 2}).status_code == 201
        assert right.post("/reservations/cart/fulfillments/box/returns", headers={"Idempotency-Key": "return"},
                          json={"quantity": 2}).status_code == 201
        basis = right.get(BASIS).json()
        assert basis["capacity"] == start["capacity"] == 20
        assert basis["revision"] == 2
        assert adjust(left, "stale", start["revision"], 21).status_code == 409
        gate = Barrier(2, timeout=5)

        def write(client, key, counted):
            gate.wait()
            return key, adjust(client, key, basis["revision"], counted)

        with ThreadPoolExecutor(max_workers=2) as pool:
            left_write = pool.submit(write, left, "left", 19)
            right_write = pool.submit(write, right, "right", 22)
            results = [left_write.result(timeout=10), right_write.result(timeout=10)]
        assert sorted(response.status_code for _, response in results) == [201, 409]
        receipt = next(response.json() for _, response in results if response.status_code == 201)
        missing = next(key for key, response in results if response.status_code == 409)
        assert right.get(ADJUSTMENTS + "/" + missing).status_code == 404
        assert left.get(BASIS).json()["capacity"] == receipt["counted"]
        assert receipt["revision"] == 3
        assert left.get("/reservations/cart").json()["held"] == 4


def test_count_upgrades_a_legacy_database_and_rolls_back_a_failed_receipt(tmp_path):
    path = tmp_path / "legacy.db"
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT);
            INSERT INTO products VALUES ('KIT-01',20,13);
            INSERT INTO reservations VALUES ('legacy-hold','KIT-01',7,'held');
        """)
    with TestClient(create_app(path, clock=lambda: 100)) as client:
        assert client.get(BASIS).json()["revision"] == 0
        assert client.get(BASIS).json()["held"] == 7
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("""CREATE TRIGGER fail_count BEFORE INSERT ON stock_count_adjustments
                            BEGIN SELECT RAISE(ABORT, 'fixture failed receipt'); END""")
        with pytest.raises(sqlite3.IntegrityError, match="fixture failed receipt"):
            adjust(client, "retry", 0, 17)
        assert client.get(BASIS).json() == {"sku": "KIT-01", "capacity": 20, "available": 13,
                                            "captured_at_ms": 100_000, "held": 7, "revision": 0}
        assert client.get(ADJUSTMENTS + "/retry").status_code == 404
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("DROP TRIGGER fail_count")
        assert adjust(client, "retry", 0, 17).raise_for_status().json()["available"] == 10
        assert adjust(client, "bad", 1, True).status_code == 422
        assert adjust(client, "bad", 1, 18, " ").status_code == 422


def batch_count(client, key, items, reason="Joint recount"):
    return client.post(BATCH, headers={"Idempotency-Key": key},
                       json={"items": items, "count_session": "shift-count", "reason": reason})


def count_item(sku, counted, revision=0):
    return {"sku": sku, "counted": counted, "expected_revision": revision}


def test_count_history_pages_same_time_batches_and_links_cross_day_reversals(tmp_path):
    path = tmp_path / "count-history.db"
    midnight = datetime.fromisoformat("2026-11-26T00:00:00+08:00").timestamp()
    now = midnight - 0.001
    with TestClient(create_app(path, clock=lambda: now)) as api:
        with Store(path).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',5,5)")
        assert batch_count(api, "prior", [count_item("WRAP-01", 5)]).status_code == 201
        now = midnight
        assert batch_count(api, "morning-a", [count_item("KIT-01", 20)]).status_code == 201
        assert batch_count(api, "morning-z", [count_item("KIT-01", 18), count_item("WRAP-01", 5)]).status_code == 201
        assert adjust(api, "single", 1, 18).status_code == 201
    with TestClient(create_app(path, clock=lambda: now)) as api, TestClient(create_app(path, clock=lambda: now)) as writer:
        filters = {"date": "2026-11-26", "sku": "KIT-01", "limit": 1}
        first = api.get(BATCH, params=filters).raise_for_status()
        assert first.headers["Cache-Control"] == "no-store"
        current = first.json()
        assert current == {"date": "2026-11-26", "sku": "KIT-01", "captured_at_ms": int(midnight * 1000),
                           "summary": {"total_batches": 2, "reversal_batches": 0, "reversed_batches": 0},
                           "batches": [{"batch_id": "morning-z", "recorded_at_ms": int(midnight * 1000),
                                        "count_session": "shift-count", "items": 2, "changed_items": 1,
                                        "source_batch_id": None, "reversal_batch_id": None}],
                           "next": {"before_recorded_at_ms": int(midnight * 1000), "before_batch_id": "morning-z"}}
        now = midnight + 86400
        correction = reversal(writer, "undo", batch_id="morning-z").raise_for_status().json()["batch_id"]
        older = api.get(BATCH, params={**filters, **current["next"]}).raise_for_status().json()
        assert [row["batch_id"] for row in older["batches"]] == ["morning-a"]
        assert older["summary"] == {"total_batches": 2, "reversal_batches": 0, "reversed_batches": 1}
        assert older["next"] is None
        original = api.get(BATCH, params=filters).json()["batches"][0]
        assert original["reversal_batch_id"] == correction
        next_day = api.get(BATCH, params={"date": "2026-11-27"}).json()
        assert next_day["summary"] == {"total_batches": 1, "reversal_batches": 1, "reversed_batches": 0}
        assert next_day["batches"][0]["source_batch_id"] == "morning-z"
        assert api.get(BATCH, params={"date": "2026-11-25"}).json()["batches"][0]["batch_id"] == "prior"
        assert api.get(BATCH, params={"sku": "UNKNOWN"}).json()["batches"] == []
        assert api.get(BATCH, params={"date": "2026-02-30"}).status_code == 422
        assert api.get(BATCH, params={"before_batch_id": "morning-z"}).status_code == 422


def test_count_batch_rolls_back_and_replays_all_receipts_after_restart(tmp_path):
    path = tmp_path / "batch-count.db"
    items = [count_item("WRAP-01", 4), count_item("KIT-01", 18)]
    with TestClient(create_app(path, clock=lambda: 100)) as api:
        with Store(path).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',5,5)")
        hold(api, 6)
        api.post("/reservations", headers={"Idempotency-Key": "wrap-cart"},
                 json={"sku": "WRAP-01", "quantity": 3}).raise_for_status()
        scope = {"skus": ["WRAP-01", "KIT-01"]}
        basis = api.post("/stock-count-basis", json=scope).raise_for_status()
        assert basis.headers["Cache-Control"] == "no-store"
        assert basis.json() == {"captured_at_ms": 100_000, "products": [
            {"sku": "KIT-01", "capacity": 20, "available": 14, "held": 6, "revision": 0},
            {"sku": "WRAP-01", "capacity": 5, "available": 2, "held": 3, "revision": 0},
        ]}
        for rejected, code in [([count_item("WRAP-01", 2), items[1]], 409),
                               ([count_item("Z-MISSING", 2), items[1]], 404),
                               ([count_item("WRAP-01", 4, 1), items[1]], 409)]:
            reply = batch_count(api, "cycle", rejected)
            assert reply.status_code == code
            assert reply.json()["detail"].startswith(rejected[0]["sku"])
            assert api.post("/stock-count-basis", json=scope).json() == basis.json()
            assert api.get(BATCH + "/cycle").status_code == 404
        assert batch_count(api, "cycle", [items[0], items[0]]).status_code == 422
        assert api.post("/stock-count-basis", json={"skus": ["KIT-01", "KIT-01"]}).status_code == 422
        assert api.post("/stock-count-basis", json={"skus": ["KIT-01", "Z-MISSING"]}).status_code == 404
        with Store(path).transaction() as conn:
            conn.execute("""CREATE TRIGGER fail_count_link BEFORE INSERT ON stock_count_batch_items
                            WHEN (SELECT sku FROM stock_count_adjustments WHERE id=NEW.adjustment_id)='WRAP-01'
                            BEGIN SELECT RAISE(ABORT, 'fixture incomplete batch'); END""")
        with pytest.raises(sqlite3.IntegrityError, match="fixture incomplete batch"):
            batch_count(api, "cycle", items)
        with Store(path).transaction() as conn:
            assert conn.execute("SELECT COUNT(*) FROM stock_count_adjustments").fetchone()[0] == 0
            conn.execute("DROP TRIGGER fail_count_link")
        assert api.post("/stock-count-basis", json=scope).json() == basis.json()
        accepted = batch_count(api, "cycle", items)
        assert accepted.status_code == 201
        receipt = accepted.json()
        assert receipt["batch_id"] == "cycle"
        assert [(line["sku"], line["counted"], line["available"], line["revision"], line["recorded_at_ms"])
                for line in receipt["items"]] == [("KIT-01", 18, 12, 1, 100_000), ("WRAP-01", 4, 1, 1, 100_000)]
        for line in receipt["items"]:
            assert api.get(f"/inventory/{line['sku']}/count-adjustments/{line['id']}").json() == line
    with TestClient(create_app(path, clock=lambda: 1000)) as restarted:
        assert restarted.get(BATCH + "/cycle").json() == receipt
        repeated = batch_count(restarted, "cycle", items[::-1])
        assert (repeated.status_code, repeated.json()) == (200, receipt)
        assert batch_count(restarted, "cycle", items, reason="Changed reason").status_code == 409
        assert batch_count(restarted, "cycle", items[:1]).status_code == 409


def test_one_stock_revision_serializes_a_single_and_a_batch_adjustment(tmp_path):
    path = tmp_path / "competing-counts.db"
    with TestClient(create_app(path)) as single, TestClient(create_app(path)) as batch:
        with Store(path).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('AUX',5,5)")
        gate = Barrier(2, timeout=5)

        def one():
            gate.wait()
            return adjust(single, "one", 0, 19)

        def many():
            gate.wait()
            return batch_count(batch, "all", [count_item("KIT-01", 18), count_item("AUX", 4)])

        with ThreadPoolExecutor(max_workers=2) as pool:
            single_write = pool.submit(one)
            batch_write = pool.submit(many)
            first, second = single_write.result(timeout=10), batch_write.result(timeout=10)
        assert sorted([first.status_code, second.status_code]) == [201, 409]
        products = batch.post("/stock-count-basis", json={"skus": ["AUX", "KIT-01"]}).json()["products"]
        expected = [(4, 1), (18, 1)] if second.status_code == 201 else [(5, 0), (19, 1)]
        assert [(product["capacity"], product["revision"]) for product in products] == expected
        assert batch.get(BATCH + "/all").status_code == (200 if second.status_code == 201 else 404)


def reversal(client, key, batch_id="cycle", reason="Recount copied from the wrong bin"):
    return client.post(f"{BATCH}/{batch_id}/reversal", headers={"Idempotency-Key": key}, json={"reason": reason})


def test_count_batch_reversal_preserves_original_and_replays_across_services(tmp_path):
    path = tmp_path / "reversals.db"
    opening = tmp_path / "before-count.db"
    with TestClient(create_app(path, clock=lambda: 100)) as first, TestClient(create_app(path, clock=lambda: 101)) as second:
        with Store(path).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',5,5)")
        hold(first, 6)
        with closing(sqlite3.connect(path)) as live, closing(sqlite3.connect(opening)) as saved:
            live.backup(saved)
        original = batch_count(first, "cycle", [count_item("KIT-01", 18), count_item("WRAP-01", 8)]).raise_for_status().json()
        assert first.get(BATCH + "/cycle/reversal").status_code == 404
        assert reversal(first, "missing", batch_id="unknown").status_code == 404
        assert reversal(first, "no-reason", reason=" ").status_code == 422
        gate = Barrier(2, timeout=5)

        def attempt(client, key):
            gate.wait()
            return key, reversal(client, key)

        with ThreadPoolExecutor(max_workers=2) as pool:
            attempts = [pool.submit(attempt, first, "first"), pool.submit(attempt, second, "second")]
            replies = [attempt.result(timeout=10) for attempt in attempts]
        assert sorted(reply.status_code for _, reply in replies) == [201, 409]
        winning_key, accepted = next((key, reply) for key, reply in replies if reply.status_code == 201)
        saved = accepted.json()
        assert accepted.headers["Cache-Control"] == "no-store"
        assert saved["source_batch_id"] == original["batch_id"]
        assert saved["batch_id"] != original["batch_id"]
        assert [(line["sku"], line["previous_capacity"], line["counted"], line["available"], line["revision"])
                for line in saved["items"]] == [("KIT-01", 18, 20, 14, 2), ("WRAP-01", 8, 5, 5, 2)]
        assert first.get(BATCH + "/cycle").json() == original
        assert first.get(BATCH + "/" + saved["batch_id"]).json() == {"batch_id": saved["batch_id"], "items": saved["items"]}
        assert first.get(BATCH + "/cycle/reversal").json() == saved
        report = reconcile(opening, path, "KIT-01")
        assert report["balanced"]
        assert sorted(line["quantity"] for line in report["new_receipts"]) == [-2, 2]
    with TestClient(create_app(path, clock=lambda: 102)) as restarted:
        assert adjust(restarted, "later", 2, 21).status_code == 201
        repeated = reversal(restarted, winning_key)
        assert (repeated.status_code, repeated.json()) == (200, saved)
        assert reversal(restarted, winning_key, reason="Changed reason").status_code == 409
        assert restarted.get(BASIS).json()["capacity"] == 21


def test_count_batch_reversal_rolls_back_on_hold_revision_and_failure_to_link(tmp_path):
    path = tmp_path / "blocked-reversals.db"
    with TestClient(create_app(path, clock=lambda: 100)) as api:
        with Store(path).transaction() as conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',5,5)")
        items = [count_item("KIT-01", 18), count_item("WRAP-01", 8)]
        batch_count(api, "cycle", items).raise_for_status()
        api.post("/reservations", headers={"Idempotency-Key": "wrap-cart"},
                 json={"sku": "WRAP-01", "quantity": 6}).raise_for_status()
        blocked = reversal(api, "undo")
        assert blocked.status_code == 409
        assert blocked.json()["detail"].startswith("WRAP-01:")
        assert api.get(BASIS).json()["capacity"] == 18
        assert api.get(BATCH + "/cycle/reversal").status_code == 404
        assert api.delete("/reservations/wrap-cart").status_code == 200
        with Store(path).transaction() as conn:
            conn.execute("""CREATE TRIGGER fail_reversal BEFORE INSERT ON stock_count_batch_reversals
                            BEGIN SELECT RAISE(ABORT, 'fixture reversal link failed'); END""")
        with pytest.raises(sqlite3.IntegrityError, match="fixture reversal link failed"):
            reversal(api, "undo")
        assert api.get(BASIS).json()["revision"] == 1
        assert api.get(BATCH + "/cycle/reversal").status_code == 404
        with Store(path).transaction() as conn:
            assert conn.execute("SELECT COUNT(*) FROM stock_count_adjustments").fetchone()[0] == 2
            conn.execute("DROP TRIGGER fail_reversal")
        assert reversal(api, "undo").status_code == 201

        moved = [{**line, "expected_revision": 2} for line in items]
        batch_count(api, "moved", moved).raise_for_status()
        assert api.post("/inventory/WRAP-01/count-adjustments", headers={"Idempotency-Key": "new-count"},
                        json={"expected_revision": 3, "counted": 9, "count_session": "another", "reason": "Recount"}).status_code == 201
        assert reversal(api, "different-undo", batch_id="moved").status_code == 409
        assert api.get(BASIS).json()["capacity"] == 18
        assert api.get("/inventory/WRAP-01/count-basis").json()["capacity"] == 9
