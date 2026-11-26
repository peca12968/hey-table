"""Run the proposed dispatches against the real Stockroom SQLite-backed API."""

import argparse
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from audit import audit
from compare_audits import compare_audits
from execute import execute, prepare
from load_scan import labels_for, verify_load
from receive_returns import receive
from replan import replan


ROOT = Path(__file__).resolve().parent


def receiving_demo(client, request):
    before = client.get("/inventory").json()[0]
    blocked_csv = "code,quantity\nDW1/B/B1/2,2\nDW1/D/D1/1,1\n"
    accepted_csv = "code,quantity\nDW1/B/B1/2,1\nDW1/D/D1/2,1\n"
    batch_id = "dock-early"
    sends = []

    def discard_first_reply(path, body=None, headers=None):
        reply = request(path, body, headers)
        if path == "/return-batches":
            sends.append(reply[0])
            if len(sends) == 1:
                raise TimeoutError("simulated loss after the return batch committed")
        return reply

    blocked = receive(blocked_csv, batch_id, discard_first_reply, confirm=True)
    assert blocked["state"] == "blocked"
    assert [row["status"] for row in blocked["boxes"]] == ["insufficient_returnable", "label_mismatch"]
    preview = receive(accepted_csv, batch_id, discard_first_reply)
    assert preview["state"] == "ready" and not sends and client.get("/inventory").json()[0] == before
    interrupted = receive(accepted_csv, batch_id, discard_first_reply, confirm=True)
    assert interrupted["state"] == "retry" and sends == [201]
    recovered = receive(accepted_csv, batch_id, discard_first_reply, confirm=True)
    assert recovered["state"] == "recovered" and sends == [201]
    assert recovered["boxes"][0]["returnable"] == 0
    assert recovered["receipt"] == client.get("/return-batches/dock-early").json()
    after = client.get("/inventory").json()[0]
    assert after["available"] == before["available"] + 2 and after["capacity"] == before["capacity"] + 2
    return {"format": "dispatch-window.return-receiving-demo.v1", "blocked_csv": blocked_csv,
            "accepted_csv": accepted_csv, "blocked": blocked, "preview": preview,
            "interrupted": interrupted, "recovered": recovered, "inventory_before": before, "inventory_after": after}


def condition_demo(client, request):
    before = client.get("/inventory").json()[0]
    header = "code,sellable,quarantined\n"
    invalid = header + "DW1/C/C1/3,1,3\nDW1/D/D1/2,0,1\n"
    valid = header + "DW1/C/C1/3,1,1\nDW1/D/D1/2,0,1\n"
    batch = "dock-conditions"
    blocked = receive(invalid, batch, request, confirm=True)
    assert blocked["state"] == "blocked"
    assert client.get("/return-inspections/" + batch).status_code == 404
    assert client.get("/inventory").json()[0] == before
    preview = receive(valid, batch, request)
    assert preview["state"] == "ready"
    confirmed = receive(valid, batch, request, confirm=True)
    assert confirmed["state"] == "received"
    recovered = receive(valid, batch, request, confirm=True)
    assert recovered["state"] == "recovered" and recovered["receipt"] == confirmed["receipt"]
    after = client.get("/inventory").json()[0]
    assert after["available"] == before["available"] + 1 and after["capacity"] == before["capacity"] + 1
    assert sum(row["quarantined"] for row in recovered["receipt"]["boxes"]) == 2
    assert client.get("/reservations/D/fulfillments/D1").json()["quarantined"] == 1
    return {"format": "dispatch-window.return-conditions-demo.v1", "blocked_csv": invalid, "accepted_csv": valid,
            "blocked": blocked, "preview": preview, "confirmed": confirmed, "recovered": recovered,
            "inventory_before": before, "inventory_after": after}


def disposition_demo(client):
    batch, operation = "dock-conditions", "quality-review"
    path = "/return-inspections/" + batch
    workbench_url = "/workbench/quarantine"
    workbench = client.get(workbench_url)
    assert workbench.status_code == 200
    assert workbench.headers["Cache-Control"] == "no-store"
    assert 'id="decision-form"' in workbench.text
    stock_before = client.get("/inventory").json()[0]
    original = client.get(path).json()
    waiting = client.get(path + "/quarantine").json()
    decisions = [
        {"reservation_id": "C", "shipment_id": "C1", "restock": 1, "discard": 0,
         "expected_remaining": 1, "reason": "外箱更換後複驗合格"},
        {"reservation_id": "D", "shipment_id": "D1", "restock": 0, "discard": 1,
         "expected_remaining": 1, "reason": "商品破損，無法再販售"},
    ]
    assert [row["remaining"] for row in waiting["boxes"]] == [1, 1]

    def submit(boxes):
        return client.post(path + "/dispositions", headers={"Idempotency-Key": operation}, json={"boxes": boxes})

    stale = submit([decisions[0], dict(decisions[1], expected_remaining=2)])
    assert stale.status_code == 409
    assert client.get(path + "/quarantine").json() == waiting
    assert client.get("/inventory").json()[0] == stock_before
    confirmed = submit(decisions)
    assert confirmed.status_code == 201
    replay = submit(decisions[::-1])
    assert replay.status_code == 200 and replay.json() == confirmed.json()
    assert client.get(path + "/dispositions/" + operation).json() == replay.json()
    final = client.get(path + "/quarantine").json()
    assert [(box["restocked"], box["discarded"], box["remaining"]) for box in final["boxes"]] == [(1, 0, 0), (0, 1, 0)]
    assert client.get(path).json() == original
    stock_after = client.get("/inventory").json()[0]
    assert stock_after["available"] == stock_before["available"] + 1
    assert stock_after["capacity"] == stock_before["capacity"] + 1
    return {"format": "dispatch-window.quarantine-disposition-demo.v1", "workbench": workbench_url,
            "waiting": waiting, "decisions": decisions,
            "stale_status": stale.status_code, "created_status": confirmed.status_code, "replay_status": replay.status_code,
            "receipt": replay.json(), "final": final, "inventory_before": stock_before, "inventory_after": stock_after}


def execution_demo(client, clock, report, manifest):
    attempts = []

    def request(path, body=None, headers=None):
        if body is None:
            response = client.get(path)
        else:
            response = client.post(path, json=body, headers=headers)
            if path == "/dispatch-batches":
                reservation = body["boxes"][0]["reservation_id"]
                attempts.append({"reservation_id": reservation, "http_status": response.status_code})
                if reservation == "B" and response.status_code == 201:
                    raise TimeoutError("simulated lost response after successful commit")
        return response.status_code, response.json()

    def execute_at(server_ms, client_ms=None, *, chosen=report, scan_log=None):
        clock[0] = server_ms / 1000
        return execute(chosen, request, clock=lambda: server_ms if client_ms is None else client_ms, scan_log=scan_log)

    waiting = execute_at(100000)
    assert not attempts
    selected = prepare(report, ("B",))
    labels = labels_for(selected)
    rejected_log = ["DW1/B/B1/2", "DW1/B/B1/2", "DW1/D/D1/2", "DW1/B/B2/1"]
    accepted_log = [label["code"] for label in reversed(labels)]
    clock[0] = 107.0
    gated = execute(report, request, clock=lambda: 107000, selected=("B",), scan_log="\n".join(rejected_log))
    assert not attempts and gated["results"] == [] and gated["confirmed_units"] == 0
    assert client.get("/reservations/B").json()["shipped"] == 0
    assert [issue["reason"] for issue in gated["load_check"]["issues"]] == [
        "duplicate_scan", "unexpected_box", "quantity_mismatch",
    ]
    ready_scan = verify_load(selected, "\n".join(accepted_log))
    assert ready_scan["ready"] and ready_scan["verified_units"] == 4
    all_codes = [label["code"] for label in labels_for(prepare(report, ()))]
    timeout = execute_at(107000, scan_log="\n".join(all_codes))
    assert timeout["load_check"]["ready"]
    recovered = execute_at(109000)
    receipt = recovered["results"][0]["receipt"]
    assert sum(box["quantity"] for box in receipt["boxes"]) == ready_scan["verified_units"]
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
    first_attempts = attempts.copy()
    clock[0] = 112.0
    next_plan = replan(manifest, {
        "cutoff_ms": 116000, "stations": 2,
        "station_pauses": [[{"start_ms": 112000, "end_ms": 115000}], []],
    }, request)
    assert next_plan["captured_at_ms"] == next_plan["start_ms"] == 112000
    assert next_plan["shipment_conflicts"] == []
    assert next_plan["omitted"] == [
        {"reservation_id": "A", "reason": "hold_closed"},
        {"reservation_id": "B", "reason": "already_dispatched"},
        {"reservation_id": "C", "reason": "already_dispatched"},
    ]
    [job] = next_plan["scheduled"]
    assert (job["reservation_id"], job["station"], job["dispatch_ms"], job["units"]) == ("D", 2, 113000, 2)
    assert next_plan["ship_units"] == 2
    before_audit = audit([report, next_plan], request)
    assert (before_audit["confirmed_units"], before_audit["pending_units"]) == (7, 2)
    assert before_audit["boxes"][-1]["reservation_state"] == "held"
    sent = execute_at(job["dispatch_ms"], chosen=next_plan)
    assert sent["confirmed_units"] == 2
    assert sent["results"][0]["state"] == "dispatched"
    old_plan = execute_at(job["dispatch_ms"])
    assert [row["state"] for row in old_plan["results"]] == ["recovered", "recovered", "recovered"]
    assert old_plan["confirmed_units"] == 9
    assert old_plan["results"][-1]["receipt"] == sent["results"][0]["receipt"]
    assert attempts == [*first_attempts, {"reservation_id": "D", "http_status": 201}]
    assert client.get("/reservations/D").json()["state"] == "fulfilled"
    after_audit = audit([report, next_plan], request)
    assert (after_audit["confirmed_units"], after_audit["pending_units"], after_audit["conflicting_boxes"]) == (9, 0, 0)
    assert after_audit["boxes"][-1]["plans"] == [{"plan": 1, "quantity": 2}, {"plan": 2, "quantity": 2}]
    altered = deepcopy(next_plan)
    altered["ship_units"] = altered["scheduled"][0]["units"] = altered["scheduled"][0]["dispatch"]["boxes"][0]["quantity"] = 1
    plan_conflict = audit([report, altered], request)
    stock_conflict = audit([altered], request)
    assert [(result["conflicting_boxes"], result["boxes"][-1]["status"], result["boxes"][-1]["recorded_units"])
            for result in (plan_conflict, stock_conflict)] == [(1, "plan_conflict", 2), (1, "quantity_conflict", 2)]
    final_inventory = client.get("/inventory").json()
    assert final_inventory == [{"sku": "KIT-01", "capacity": 11, "available": 11}]
    clock[0] = 114.0
    returned = client.post("/reservations/B/fulfillments/B1/returns",
                           headers={"Idempotency-Key": "audit-return-B1"}, json={"quantity": 1})
    assert returned.status_code == 201
    after_returns = audit([report, next_plan], request)
    movement = compare_audits(before_audit, after_returns)
    corrected = compare_audits(plan_conflict, after_returns)
    expanded = compare_audits(stock_conflict, after_returns)
    assert (movement["new_dispatched_units"], movement["new_restocked_units"]) == (2, 1)
    assert [change["shipment_id"] for change in movement["changes"]] == ["B1", "D1"]
    assert (corrected["resolved_conflicts"], corrected["new_dispatched_units"], corrected["new_restocked_units"]) == (1, 0, 1)
    assert (expanded["added_boxes"], expanded["comparable_boxes"], expanded["new_restocked_units"]) == (3, 1, 0)
    assert client.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 12, "available": 12}]
    returns = receiving_demo(client, request)
    conditions = condition_demo(client, request)
    disposition = disposition_demo(client)
    return {"format": "dispatch-window.execution-demo.v1", "start_ms": report["start_ms"],
            "stages": stages, "attempts": first_attempts, "inventory_after": with_inventory[0],
            "next_truck": {"plan": next_plan, "execution": sent, "first_truck_review": old_plan,
                           "inventory_after": final_inventory[0]},
            "load_scan": {"format": "dispatch-window.load-scan-demo.v1", "labels": labels,
                          "rejected_log": rejected_log, "accepted_log": accepted_log, "rejected": gated["load_check"],
                          "accepted": ready_scan, "receipt": receipt},
            "return_receiving": returns,
            "return_conditions": conditions,
            "quarantine_disposition": disposition,
            "audit": {"format": "dispatch-window.audit-demo.v1", "before": before_audit, "after": after_audit,
                      "plan_conflict": plan_conflict, "stock_conflict": stock_conflict,
                      "after_returns": after_returns, "differences": {"movement": movement, "corrected": corrected,
                                                                    "expanded": expanded}}}


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
                return execution_demo(client, clock, chosen, document)
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
