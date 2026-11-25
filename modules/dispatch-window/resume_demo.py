"""Replan outstanding boxes from real Stockroom packing snapshots."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parent


def demo(stockroom):
    sys.path.insert(0, str(stockroom.resolve()))
    from stockroom.api import create_app

    with TemporaryDirectory() as temp:
        root = Path(temp)
        db = root / "warehouse.db"
        now = 80
        work = [
            {"reservation_id": "A", "ready_ms": 100_000, "pack_ms": 6_000, "boxes": [
                {"shipment_id": "A1", "quantity": 3, "pack_ms": 3_000},
                {"shipment_id": "A2", "quantity": 2, "pack_ms": 2_000},
            ]},
            {"reservation_id": "B", "ready_ms": 100_000, "pack_ms": 4_000,
             "boxes": [{"shipment_id": "B1", "quantity": 4}]},
            {"reservation_id": "C", "ready_ms": 100_000, "pack_ms": 1_000,
             "boxes": [{"shipment_id": "C1", "quantity": 2}]},
        ]
        with TestClient(create_app(db, ttl_seconds=20, clock=lambda: now)) as api:
            def hold(key, quantity):
                api.post("/reservations", headers={"Idempotency-Key": key},
                         json={"sku": "KIT-01", "quantity": quantity}).raise_for_status()

            def input_document():
                capture = api.post("/packing-snapshots", json={
                    "reservation_ids": [order["reservation_id"] for order in work],
                }).raise_for_status().json()
                return {**capture, "start_ms": capture["captured_at_ms"], "cutoff_ms": 107_500, "work": work}

            def plan(document, *options):
                file = root / "snapshot.json"
                file.write_text(json.dumps(document), encoding="utf-8")
                return json.loads(subprocess.check_output([sys.executable, ROOT / "dispatch.py", file, *options]))

            hold("C", 2)
            now = 90
            hold("A", 5)
            hold("B", 4)
            now = 99
            api.post("/reservations/A/fulfillments", headers={"Idempotency-Key": "A1"},
                     json={"quantity": 3}).raise_for_status()
            now = 100
            snapshot = input_document()
            baseline = plan(snapshot)
            resumed = plan(snapshot, "--resume")
            wrong_quantity = deepcopy(snapshot)
            wrong_quantity["work"][0]["boxes"][0]["quantity"] = 4
            conflict = plan(wrong_quantity, "--resume")
            assert baseline["ship_units"] == 4 and resumed["ship_units"] == 6
            assert resumed["already_dispatched"] == [{"reservation_id": "A", "shipment_id": "A1", "quantity": 3}]
            assert conflict["shipment_conflicts"] == [
                {"reservation_id": "A", "shipment_id": "A1", "planned_quantity": 4, "recorded_quantity": 3},
            ]
            for job in resumed["scheduled"]:
                now = job["dispatch_ms"] / 1000
                response = api.post("/dispatch-batches",
                                    headers={"Idempotency-Key": "resumed-" + job["reservation_id"]}, json=job["dispatch"])
                assert response.status_code == 201, response.text
            final_snapshot = input_document()
            finished = plan(final_snapshot, "--resume")
            assert finished["scheduled"] == []
            assert final_snapshot["products"] == [{"sku": "KIT-01", "capacity": 11, "available": 11}]
            return {"format": "dispatch-window.resume-demo.v1", "baseline": baseline, "resumed": resumed,
                    "conflict": conflict, "finished": finished,
                    "inventory_after": final_snapshot["products"][0]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom", type=Path)
    print(json.dumps(demo(parser.parse_args().stockroom), indent=2))
