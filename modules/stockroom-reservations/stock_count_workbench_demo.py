"""Replay a two-SKU count, including rollback and same-batch recovery."""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import UUID

from fastapi.testclient import TestClient

from stockroom.api import create_app


def demonstrate(database):
    now = [100.0]
    target = {"KIT-01": 19, "WRAP-01": 12}
    batch = "morning-cycle"
    with TestClient(create_app(database, clock=lambda: now[0])) as api:
        with closing(sqlite3.connect(database)) as conn, conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01',10,10)")
        hold = api.post("/reservations", headers={"Idempotency-Key": "shelf-hold"},
                        json={"sku": "KIT-01", "quantity": 6})
        assert hold.status_code == 201
        workbench = "/workbench/stock-count"
        html = api.get(workbench)
        assert html.status_code == 200 and html.headers["Cache-Control"] == "no-store"
        assert 'id="count-panel"' in html.text

        def basis():
            response = api.post("/stock-count-basis", json={"skus": list(target)})
            assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
            return response.json()

        def commit(snapshot):
            items = [{"sku": item["sku"], "expected_revision": item["revision"], "counted": target[item["sku"]]}
                     for item in snapshot["products"]]
            return api.post("/stock-count-batches", headers={"Idempotency-Key": batch},
                            json={"items": items, "count_session": "morning", "reason": "audited cycle count"})

        opening = basis()
        now[0] = 101.0
        companion = api.post("/inventory/WRAP-01/count-adjustments",
                             headers={"Idempotency-Key": "shared-shelf"},
                             json={"expected_revision": opening["products"][1]["revision"], "counted": 11,
                                   "count_session": "receiving", "reason": "corrected shelf count"})
        assert companion.status_code == 201
        before_attempt = basis()
        stale = commit(opening)
        assert stale.status_code == 409
        assert api.get("/stock-count-batches/" + batch).status_code == 404
        refreshed = basis()
        assert refreshed == before_attempt
        assert refreshed["products"][0] == opening["products"][0]
        assert refreshed["products"][1]["revision"] != opening["products"][1]["revision"]
        now[0] = 102.0
        applied = commit(refreshed)
        assert applied.status_code == 201
        saved = applied.json()
        replay = commit(refreshed)
        assert replay.status_code == 200 and replay.json() == saved
        assert api.get("/stock-count-batches/" + batch).json() == saved
        assert [(row["counted"], row["available"]) for row in saved["items"]] == [(19, 13), (12, 12)]
        history_path = "/workbench/stock-count-history"
        assert api.get(history_path).status_code == 200
        query = {"sku": "WRAP-01", "limit": 1}
        original = api.get("/stock-count-batches", params=query).raise_for_status().json()
        correction_path = "/stock-count-batches/" + batch + "/reversal"
        preview_path = correction_path + "-preview"
        initial_review = api.get(preview_path).raise_for_status().json()
        now[0] = 103.0
        assert api.post("/reservations", headers={"Idempotency-Key": "wrap-review-hold"},
                        json={"sku": "WRAP-01", "quantity": 12}).status_code == 201
        blocked_review = api.get(preview_path).raise_for_status().json()
        assert blocked_review["preview_digest"] is None

        def reverse(digest):
            return api.post(correction_path, headers={"Idempotency-Key": "undo-count"},
                            json={"reason": "second shelf review", "preview_digest": digest})

        stale_review = reverse(initial_review["preview_digest"])
        assert stale_review.status_code == 409 and api.get(correction_path).status_code == 404
        assert api.delete("/reservations/wrap-review-hold").status_code == 200
        assert api.post("/reservations", headers={"Idempotency-Key": "wrap-small-hold"},
                        json={"sku": "WRAP-01", "quantity": 2}).status_code == 201
        refreshed_review = api.get(preview_path).raise_for_status().json()
        assert refreshed_review["preview_digest"] != initial_review["preview_digest"]
        ids = [UUID(f"10000000-0000-4000-8000-{number:012d}") for number in (1, 2, 3)]
        with patch("stockroom.store.uuid4", side_effect=ids):
            reversed_response = reverse(refreshed_review["preview_digest"])
            reversal = reversed_response.raise_for_status().json()
        reversal_replay = reverse(refreshed_review["preview_digest"])
        assert reversed_response.status_code == 201 and reversal_replay.status_code == 200
        assert reversal_replay.json() == reversal
        latest = api.get("/stock-count-batches", params=query).raise_for_status().json()
        older = api.get("/stock-count-batches", params={**query, **latest["next"]}).raise_for_status().json()
        assert latest["batches"][0]["batch_id"] == reversal["batch_id"]
        assert latest["batches"][0]["source_batch_id"] == batch
        assert older["batches"][0]["reversal_batch_id"] == reversal["batch_id"]
        return {"workbench": workbench, "opening": opening, "target": target, "before_attempt": before_attempt,
                "stale_status": stale.status_code, "refreshed": refreshed, "created_status": applied.status_code,
                "replay_status": replay.status_code, "receipt": {
                    "batch_id": batch, "items": [{key: value for key, value in row.items() if key != "id"} for row in saved["items"]],
                }, "history": {"workbench": history_path, "original": original, "latest": latest, "older": older},
                "reversal": {"workbench": "/workbench/stock-count-reversal", "initial": initial_review,
                             "blocked": blocked_review, "refreshed": refreshed_review,
                             "stale_status": stale_review.status_code, "created_status": reversed_response.status_code,
                             "replay_status": reversal_replay.status_code,
                             "receipt": {**reversal, "items": [{key: value for key, value in row.items() if key != "id"}
                                                               for row in reversal["items"]]}}}


if __name__ == "__main__":
    with TemporaryDirectory() as temporary:
        print(json.dumps(demonstrate(Path(temporary) / "stock-count.sqlite"), indent=2, ensure_ascii=False))
