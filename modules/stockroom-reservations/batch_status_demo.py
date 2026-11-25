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

        focus = new_batch["items"][0]
        key = focus["id"]
        history_path = f"/reservations/{key}/renewals"
        api.post(history_path, headers={"Idempotency-Key": "loading-buffer"},
                 json={"expected_expires_at_ms": by_id[key]["expires_at_ms"], "extend_seconds": 5}).raise_for_status()
        history = api.get(history_path).raise_for_status().json()
        renewal_batch["history"] = {
            "sku": history["reservation"]["sku"],
            "expires_at_ms": history["reservation"]["expires_at_ms"],
            "renewals": history["renewals"],
        }

        now = 300
        release_batch = capture_release_batch(api)
        now = 301
        focus_key = release_batch["items"][0]["reservation_id"]
        release_batch["history"] = capture_release_history(api, focus_key)

    return {"stages": stages, "renewal_batch": renewal_batch, "release_batch": release_batch,
            "replacement": capture_replacement(db), "batch_replacement": capture_batch_replacement(db)}


def capture_release_batch(api):
    orders = [("order-east", "KIT-01", 4, 2), ("order-west", "WRAP-01", 2, 2)]
    scope = {"reservation_ids": [key for key, _, _, _ in orders]}
    for key, sku, held, _ in orders:
        api.post("/reservations", headers={"Idempotency-Key": key},
                 json={"sku": sku, "quantity": held}).raise_for_status()

    def snapshot():
        view = api.post("/packing-snapshots", json=scope).raise_for_status().json()
        return (view["captured_at_ms"],
                {row["reservation"]["id"]: row["reservation"]["held"] for row in view["holds"]},
                {row["sku"]: row for row in view["products"]})

    captured_at, held_before, stock_before = snapshot()
    items = [{"reservation_id": key, "expected_held": held_before[key], "quantity": quantity}
             for key, _, _, quantity in orders]
    endpoint, headers = "/release-batches", {"Idempotency-Key": "remove-backorders"}
    stale = [items[0], {**items[1], "expected_held": items[1]["expected_held"] + 1}]
    conflict = api.post(endpoint, headers=headers, json={"items": stale})
    _, held_after_conflict, stock_after_conflict = snapshot()
    accepted = api.post(endpoint, headers=headers, json={"items": items})
    receipt = accepted.raise_for_status().json()
    recovered = api.get(f"{endpoint}/{receipt['batch_id']}").raise_for_status().json()
    replay = api.post(endpoint, headers=headers, json={"items": items[::-1]})
    _, held_after, stock_after = snapshot()
    return {
        "batch_id": receipt["batch_id"], "captured_at_ms": captured_at, "released_at_ms": receipt["released_at_ms"],
        "stale_status": conflict.status_code, "accepted_status": accepted.status_code, "replay_status": replay.status_code,
        "same_receipt": recovered == receipt == replay.json(),
        "items": [{**line, "sku": sku, "held_after_conflict": held_after_conflict[key],
                   "held_after_snapshot": held_after[key],
                   "available_before": stock_before[sku]["available"],
                   "available_after_conflict": stock_after_conflict[sku]["available"],
                   "available_after": stock_after[sku]["available"],
                   "capacity_before": stock_before[sku]["capacity"], "capacity_after": stock_after[sku]["capacity"]}
                  for line, (key, sku, _, _) in zip(receipt["items"], orders, strict=True)],
    }


def capture_release_history(api, key):
    path = f"/reservations/{key}/releases"
    api.post(path, headers={"Idempotency-Key": "remove-one"}, json={"quantity": 1}).raise_for_status()
    first = api.get(path, params={"limit": 1}).raise_for_status().json()
    older = api.get(path, params={"limit": 1, "after_held": first["next_after_held"]}).raise_for_status().json()
    return {
        "reservation_id": key, "held": first["reservation"]["held"], "captured_at_ms": first["captured_at_ms"],
        "pages": [{name: page[name] for name in ("releases", "next_after_held")} for page in (first, older)],
    }


def capture_replacement(db):
    now = 400
    with TestClient(create_app(db, ttl_seconds=3, clock=lambda: now)) as api:
        key = "cart-recovered"
        path = f"/reservations/{key}"
        api.post("/reservations", headers={"Idempotency-Key": key},
                 json={"sku": "KIT-01", "quantity": 8}).raise_for_status()
        api.post(path + "/fulfillments", headers={"Idempotency-Key": "box"},
                 json={"quantity": 1}).raise_for_status()
        api.post(path + "/releases", headers={"Idempotency-Key": "customer-edit"},
                 json={"quantity": 2}).raise_for_status()
        before = api.get(path).raise_for_status().json()
        now = 403
        capacity = api.get("/inventory").raise_for_status().json()[0]["capacity"]
        api.post("/reservations", headers={"Idempotency-Key": "competing-cart"},
                 json={"sku": "KIT-01", "quantity": capacity}).raise_for_status()
        headers = {"Idempotency-Key": "recover-cart"}
        conflict = api.post(path + "/replacement", headers=headers)
        missing = api.get(path + "/replacement")
        api.delete("/reservations/competing-cart").raise_for_status()
        accepted = api.post(path + "/replacement", headers=headers)
        receipt = accepted.raise_for_status().json()
        recovered = api.get(path + "/replacement").raise_for_status().json()
        replay = api.post(path + "/replacement", headers=headers)
        current = api.get("/reservations/" + receipt["reservation"]["id"]).raise_for_status().json()
        original = api.get(path).raise_for_status().json()
        stock = api.get("/inventory").raise_for_status().json()[0]
        return {
            "source": original, "held_before_expiry": before["held"], "released_before_expiry": before["returned"],
            "shortage_status": conflict.status_code, "missing_receipt_status": missing.status_code,
            "accepted_status": accepted.status_code, "replay_status": replay.status_code,
            "same_receipt": recovered == receipt == replay.json(),
            "created_at_ms": receipt["created_at_ms"], "new_expires_at_ms": receipt["reservation"]["expires_at_ms"],
            "new_hold": current["held"], "new_id": current["id"] != key, "stock": stock,
        }


def capture_batch_replacement(db):
    now = 500
    with TestClient(create_app(db, ttl_seconds=3, clock=lambda: now)) as api:
        batch_id = "recover-set"
        path = f"/reservation-batches/{batch_id}"
        old = api.post("/reservation-batches", headers={"Idempotency-Key": batch_id}, json={
            "items": [{"sku": "KIT-01", "quantity": 4}, {"sku": "WRAP-01", "quantity": 2}],
        }).raise_for_status().json()
        main = old["items"][0]["id"]
        api.post(f"/reservations/{main}/fulfillments", headers={"Idempotency-Key": "box"},
                 json={"quantity": 1}).raise_for_status()
        api.post(f"/reservations/{main}/releases", headers={"Idempotency-Key": "box-change"},
                 json={"quantity": 1}).raise_for_status()
        original = api.get(path + "/status").raise_for_status().json()
        now = 503
        api.post("/reservations", headers={"Idempotency-Key": "hold-packaging"},
                 json={"sku": "WRAP-01", "quantity": 2}).raise_for_status()
        def preview():
            data = api.get(path + "/replacement-preview").raise_for_status().json()
            return {"status": data["status"], "captured_at_ms": data["captured_at_ms"],
                    "items": [{key: row[key] for key in ("sku", "expired_quantity", "available", "shortfall", "status")}
                              for row in data["items"]]}

        blocked = preview()
        before_conflict = api.get("/inventory").raise_for_status().json()
        headers = {"Idempotency-Key": "continue-kit-and-packaging"}
        shortage = api.post(path + "/replacement", headers=headers)
        after_conflict = api.get("/inventory").raise_for_status().json()
        missing = api.get(path + "/replacement")
        api.delete("/reservations/hold-packaging").raise_for_status()
        ready = preview()
        before_commit = api.get("/inventory").raise_for_status().json()
        accepted = api.post(path + "/replacement", headers=headers)
        receipt = accepted.raise_for_status().json()
        replay = api.post(path + "/replacement", headers=headers)
        recovered = api.get(path + "/replacement").raise_for_status().json()
        after_commit = api.get("/inventory").raise_for_status().json()
        new = api.get(f"/reservation-batches/{receipt['batch_id']}/status").raise_for_status().json()
        stocks = [{line["sku"]: line for line in stock}
                  for stock in (before_conflict, after_conflict, before_commit, after_commit)]
        items = []
        for old_line, new_line in zip(original["items"], new["items"], strict=True):
            sku = old_line["sku"]
            before, rejected, successful, updated = [stock[sku]["available"] for stock in stocks]
            items.append({
                "sku": sku, "original": old_line["quantity"], "shipped": old_line["shipped"],
                "released_before_expiry": old_line["returned"], "expired": old_line["held"],
                "new_held": new_line["held"], "capacity": stocks[0][sku]["capacity"],
                "before_conflict": before, "after_conflict": rejected,
                "before_commit": successful, "after_commit": updated,
            })
        return {
            "source_batch_id": batch_id, "new_batch_created": receipt["batch_id"] != batch_id,
            "shortage_status": shortage.status_code, "missing_receipt_status": missing.status_code,
            "accepted_status": accepted.status_code, "replay_status": replay.status_code,
            "same_receipt": replay.json() == receipt == recovered, "created_at_ms": receipt["created_at_ms"],
            "expires_at_ms": receipt["expires_at_ms"], "items": items,
            "preview": {"blocked": blocked, "ready": ready},
        }


if __name__ == "__main__":
    with TemporaryDirectory() as folder:
        print(json.dumps(capture(Path(folder) / "demo.db"), indent=2))
