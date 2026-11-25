"""Run the proposed dispatches against the real Stockroom SQLite-backed API."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from execute import execute


ROOT = Path(__file__).resolve().parent


def execution_demo(client, clock, report):
    attempts = []

    def request(path, body=None, headers=None):
        if body is None:
            response = client.get(path)
        else:
            response = client.post(path, json=body, headers=headers)
            reservation = body["boxes"][0]["reservation_id"]
            attempts.append({"reservation_id": reservation, "http_status": response.status_code})
            if reservation == "B" and response.status_code == 201:
                raise TimeoutError("simulated lost response after successful commit")
        return response.status_code, response.json()

    def execute_at(server_ms, client_ms=None):
        clock[0] = server_ms / 1000
        return execute(report, request, clock=lambda: server_ms if client_ms is None else client_ms)

    waiting = execute_at(100000)
    assert not attempts
    timeout = execute_at(107000)
    recovered = execute_at(109000)
    late = execute_at(111000, 110000)
    reconciled = execute_at(111000)

    stages = {"waiting": waiting, "timeout": timeout, "recovered": recovered, "late": late, "reconciled": reconciled}
    assert [[row["state"] for row in stage["results"]] for stage in stages.values()] == [
        ["waiting", "waiting", "waiting"],
        ["retry", "waiting", "waiting"],
        ["recovered", "dispatched", "waiting"],
        ["recovered", "recovered", "rejected"],
        ["recovered", "recovered", "expired"],
    ]
    assert attempts == [{"reservation_id": reservation, "http_status": status}
                        for reservation, status in [("B", 201), ("C", 201), ("D", 409)]]
    assert [stage["confirmed_units"] for stage in stages.values()] == [0, 0, 7, 7, 7]
    assert recovered["results"][0]["receipt"] == reconciled["results"][0]["receipt"]
    assert client.get("/reservations/A").json()["state"] == "expired"
    assert client.get("/reservations/D").json()["state"] == "held"
    with_inventory = client.get("/inventory").json()
    assert with_inventory == [{"sku": "KIT-01", "capacity": 13, "available": 11}]
    return {"format": "dispatch-window.execution-demo.v1", "start_ms": report["start_ms"],
            "stages": stages, "attempts": attempts, "inventory_after": with_inventory[0]}


def demo(stockroom, stations=1, delayed=False, *, paused=False, restricted=False, execute_plan=False):
    sys.path.insert(0, str(stockroom.resolve()))
    from stockroom.api import create_app

    document = json.loads((ROOT / "examples/morning.json").read_bytes())
    expected = document["holds"]
    with TemporaryDirectory() as temp:
        path = Path(temp)
        db = path / "stockroom.db"
        clock = [0.0]
        with TestClient(
            create_app(db, ttl_seconds=20, clock=lambda: clock[0])
        ) as client:
            for snapshot in expected[:3]:
                data = snapshot["reservation"]
                clock[0] = data["expires_at_ms"] / 1000 - 20
                reply = client.post(
                    "/reservations",
                    headers={"Idempotency-Key": data["id"]},
                    json={"sku": "KIT-01", "quantity": data["held"]},
                )
                assert (
                    reply.status_code == 201
                    and reply.json()["expires_at_ms"] == data["expires_at_ms"]
                )
            with closing(sqlite3.connect(db)) as conn, conn:
                conn.execute(
                    "INSERT INTO reservations(id,sku,quantity,state) VALUES ('D','KIT-01',2,'held')"
                )
                conn.execute(
                    "UPDATE products SET available=available-2 WHERE sku='KIT-01'"
                )
            clock[0] = 100.0
            response = client.post(
                "/packing-snapshots",
                json={
                    "reservation_ids": [item["reservation"]["id"] for item in expected]
                },
            )
            assert response.status_code == 200, response.text
            capture = response.json()
            assert capture["captured_at_ms"] == document["start_ms"]
            document.update(capture)
            if delayed:
                document["station_ready_ms"] = [document["start_ms"], document["start_ms"] + 4000]
            if paused:
                start = document["start_ms"]
                document["station_pauses"] = [[], [{"start_ms": start + 8000, "end_ms": start + 9000}]]
            if restricted:
                next(order for order in document["work"] if order["reservation_id"] == "C")["allowed_stations"] = [2]
            input_file = path / "service-snapshot.json"
            input_file.write_text(json.dumps(document), encoding="utf8")
            output = subprocess.check_output([
                sys.executable, ROOT / "dispatch.py", input_file, "--stations", str(stations)
            ])
            chosen = json.loads(output)
            if execute_plan:
                return execution_demo(client, clock, chosen)
            skips_a = stations == 1 or delayed
            assert chosen["ship_units"] == 10 - int(skips_a) - (3 if restricted else 0)
            assert [row["reservation_id"] for row in chosen["scheduled"]] == [
                *([] if skips_a else ["A"]), "B", *([] if restricted else ["C"]), "D",
            ]
            if restricted:
                assert chosen["omitted"] == [{"reservation_id": "C", "reason": "cannot_finish_before_deadline"}]
                assert chosen["allowed_stations"] == {"C": [2]}
            elif paused and not delayed:
                assert next(row for row in chosen["scheduled"] if row["reservation_id"] == "C")["station"] == 1
            if skips_a:
                clock[0] = 105.0
                at_deadline = client.post(
                    "/dispatch-batches",
                    headers={"Idempotency-Key": "late-A"},
                    json={"boxes": [{"reservation_id": "A", "shipment_id": "A1", "quantity": 1}]},
                )
                assert at_deadline.status_code == 409
            for job in chosen["scheduled"]:
                clock[0] = job["dispatch_ms"] / 1000
                reply = client.post(
                    "/dispatch-batches",
                    headers={"Idempotency-Key": "wave-" + job["reservation_id"]},
                    json=job["dispatch"],
                )
                assert reply.status_code == 201, reply.text
                assert (
                    sum(box["quantity"] for box in reply.json()["boxes"])
                    == job["units"]
                )
            assert client.get("/reservations/A").json()["state"] == ("expired" if skips_a else "fulfilled")
            assert client.get("/reservations/C").json()["state"] == ("expired" if restricted else "fulfilled")
            assert client.get("/inventory").json() == [
                {"sku": "KIT-01", "capacity": 20 - chosen["ship_units"], "available": 20 - chosen["ship_units"]}
            ]
        return chosen


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--compare-stations", action="store_true")
    mode.add_argument("--execute-plan", action="store_true")
    args = parser.parse_args()
    result = demo(args.stockroom, execute_plan=args.execute_plan)
    if args.compare_stations:
        result = {"format": "dispatch-window.parallel-demo.v1", "single": result,
                  "parallel": demo(args.stockroom, stations=2),
                  "delayed": demo(args.stockroom, stations=2, delayed=True),
                  "paused": demo(args.stockroom, stations=2, paused=True),
                  "restricted": demo(args.stockroom, stations=2, paused=True, restricted=True)}
    print(json.dumps(result, indent=2))
