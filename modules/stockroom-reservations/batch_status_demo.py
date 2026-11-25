"""Export staged HTTP snapshots from a disposable Stockroom database."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from stockroom.api import create_app


def capture(db):
    now = 100
    batch_path = "/reservation-batches/order-24"
    items = [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}]
    stages = []

    with TestClient(create_app(db, ttl_seconds=3, clock=lambda: now)) as api:
        with closing(sqlite3.connect(db)) as conn, conn:
            conn.execute("INSERT INTO products VALUES ('WRAP-01', 2, 2)")

        def record(stage):
            result = api.get(f"{batch_path}/status").raise_for_status().json()
            for item in result["items"]:
                del item["id"]
            queue = api.get("/expiring-reservations", params={"within_seconds": 4}).raise_for_status().json()
            expiring = [{key: row[key] for key in ("sku", "expires_at_ms", "held")} for row in queue["reservations"]]
            result["expiry_queue"] = {
                "through_ms": queue["through_ms"],
                "reservations": sorted(expiring, key=lambda row: (row["expires_at_ms"], row["sku"])),
            }
            stages.append({"stage": stage, **result})

        receipt = api.post("/reservation-batches", headers={"Idempotency-Key": "order-24"},
                           json={"items": items}).raise_for_status().json()
        record("reserved")

        now = 101
        kit, wrap = [f"/reservations/{item['id']}" for item in receipt["items"]]
        api.post(f"{kit}/fulfillments", headers={"Idempotency-Key": "box"},
                 json={"quantity": 1}).raise_for_status()
        api.post(f"{wrap}/renewals", headers={"Idempotency-Key": "more-time"},
                 json={"expected_expires_at_ms": receipt["expires_at_ms"], "extend_seconds": 10}).raise_for_status()
        record("adjusted")

        now = 103
        record("expired")

        now = 104
        api.delete(batch_path).raise_for_status()
        record("cancelled")

        now = 200
        new_batch = api.post("/reservation-batches", headers={"Idempotency-Key": "renew-demo"},
                             json={"items": items}).raise_for_status().json()
        before = api.get("/expiring-reservations", params={"within_seconds": 4}).raise_for_status().json()
        deadline = {hold["reservation_id"]: hold["expires_at_ms"] for hold in before["reservations"]}
        selected = [{"reservation_id": item["id"], "expected_expires_at_ms": deadline[item["id"]]}
                    for item in new_batch["items"]]
        stale = [selected[0], {**selected[1], "expected_expires_at_ms": deadline[selected[1]["reservation_id"]] + 1}]
        headers = {"Idempotency-Key": "delay-truck"}
        rejected = api.post("/renewal-batches", headers=headers, json={"items": stale, "extend_seconds": 10})
        after_rejection = api.get("/expiring-reservations", params={"within_seconds": 4}).raise_for_status().json()
        unchanged = {hold["reservation_id"]: hold["expires_at_ms"] for hold in after_rejection["reservations"]}
        accepted = api.post("/renewal-batches", headers=headers, json={"items": selected, "extend_seconds": 10})
        renewal = accepted.raise_for_status().json()
        replay = api.post("/renewal-batches", headers=headers,
                          json={"items": selected[::-1], "extend_seconds": 10})
        after_commit = api.get("/expiring-reservations", params={"within_seconds": 4}).raise_for_status().json()
        by_id = {row["reservation_id"]: row for row in renewal["items"]}
        renewal_batch = {
            "captured_at_ms": before["captured_at_ms"],
            "through_ms": before["through_ms"],
            "extend_seconds": 10,
            "stale_status": rejected.status_code,
            "accepted_status": accepted.status_code,
            "replay_status": replay.status_code,
            "same_receipt": replay.json() == renewal,
            "queued_after_commit": len(after_commit["reservations"]),
            "items": [{"sku": row["sku"], "previous_expires_at_ms": by_id[row["id"]]["previous_expires_at_ms"],
                       "after_rejected_expires_at_ms": unchanged[row["id"]], "expires_at_ms": by_id[row["id"]]["expires_at_ms"]}
                      for row in new_batch["items"]],
        }

    return {"stages": stages, "renewal_batch": renewal_batch}


if __name__ == "__main__":
    with TemporaryDirectory() as folder:
        print(json.dumps(capture(Path(folder) / "demo.db"), indent=2))
