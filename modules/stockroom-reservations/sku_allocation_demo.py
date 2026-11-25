"""Capture a SKU's allocation report before and after expiry and dispatch."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from stockroom.api import create_app
from stockroom.store import Store


def capture(path):
    now = 100
    endpoint = "/inventory/KIT-01/allocations"
    with TestClient(create_app(path, ttl_seconds=20, clock=lambda: now)) as api:
        def post(url, key, payload):
            return api.post(url, headers={"Idempotency-Key": key}, json=payload).raise_for_status()

        def hold(key, quantity):
            post("/reservations", key, {"sku": "KIT-01", "quantity": quantity})

        def ship(key, quantity):
            post("/reservations/a-dispatch/fulfillments", key, {"quantity": quantity})

        hold("c-legacy", 3)
        with Store(path).transaction() as conn:
            conn.execute("UPDATE reservations SET expires_at_ms=NULL WHERE id='c-legacy'")
        hold("b-expiring", 3)
        now = 105
        hold("a-dispatch", 4)
        now = 110
        ship("first-box", 1)
        first = api.get(endpoint, params={"limit": 1}).raise_for_status().json()
        rest = api.get(endpoint, params={"after_id": first["next_after_id"]}).raise_for_status().json()
        now = 120
        expired = api.get(endpoint).raise_for_status().json()
        ship("last-box", 3)
        dispatched = api.get(endpoint).raise_for_status().json()
        return {"format": "stockroom.sku-allocations-demo.v1", "before": first, "continuation": rest,
                "after_expiry": expired, "after_dispatch": dispatched}


if __name__ == "__main__":
    with TemporaryDirectory() as directory:
        print(json.dumps(capture(Path(directory) / "warehouse.db"), indent=2))
