"""Reconcile boxes across truck plans with one Stockroom packing snapshot."""

import argparse
from http.client import HTTPException
import json
from pathlib import Path
import sys

from dispatch import indexed, integer
from execute import prepare, stockroom_client
from replan import packing_snapshot


def audit(plans, request):
    box_plans = {}
    reservation_ids = set()
    for wave, report in enumerate(plans, 1):
        for job in prepare(report, ()):
            reservation = job["reservation_id"]
            reservation_ids.add(reservation)
            for box in job["boxes"]:
                pair = (reservation, box["shipment_id"])
                box_plans.setdefault(pair, []).append({"plan": wave, "quantity": box["quantity"]})

    if len(reservation_ids) > 100:
        raise ValueError("Stockroom can audit at most 100 reservations in one packing snapshot")
    snapshot = packing_snapshot(request, reservation_ids) if reservation_ids else None
    captured = integer(snapshot["captured_at_ms"], "captured_at_ms") if snapshot is not None else None
    statements = [{"id": row["reservation"]["id"], "snapshot": row} for row in snapshot["holds"]] if snapshot is not None else []
    holds = indexed(statements, "id")
    if holds.keys() != reservation_ids:
        raise ValueError("packing snapshot does not cover the planned reservations")
    recorded = {}
    reservation_states = {}
    for reservation, entry in holds.items():
        statement = entry["snapshot"]
        state = statement["reservation"]["state"]
        if state not in ("held", "expired", "released", "fulfilled"):
            raise ValueError(f"{reservation}: unknown reservation state")
        reservation_states[reservation] = state
        for shipment, box in indexed(statement["boxes"], "shipment_id").items():
            if box["reservation_id"] != reservation:
                raise ValueError(f"{reservation}/{shipment}: snapshot box belongs to another reservation")
            units = integer(box["dispatched"], "dispatched", 1, 1_000_000)
            recorded[reservation, shipment] = (units, integer(box["restocked"], "restocked", high=units))

    boxes = []
    confirmed_units = pending_units = conflicting_boxes = 0
    for pair, references in sorted(box_plans.items()):
        reservation, shipment = pair
        amounts = {reference["quantity"] for reference in references}
        dispatched, restocked = recorded.get(pair, (None, None))
        if len(amounts) > 1:
            status = "plan_conflict"
            conflicting_boxes += 1
        elif dispatched is None:
            status = "pending"
            pending_units += references[0]["quantity"]
        elif dispatched != references[0]["quantity"]:
            status = "quantity_conflict"
            conflicting_boxes += 1
        else:
            status = "confirmed"
            confirmed_units += dispatched
        boxes.append({"reservation_id": reservation, "shipment_id": shipment, "plans": references,
                      "recorded_units": dispatched, "restocked_units": restocked,
                      "reservation_state": reservation_states[reservation], "status": status})
    return {"format": "dispatch-window.audit.v1", "captured_at_ms": captured, "plan_count": len(plans),
            "confirmed_units": confirmed_units, "pending_units": pending_units,
            "conflicting_boxes": conflicting_boxes, "boxes": boxes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plans", nargs="+", type=Path, help="Dispatch Window reports in truck order")
    parser.add_argument("--stockroom", required=True, help="Stockroom HTTP(S) base URL")
    args = parser.parse_args(argv)
    try:
        plans = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.plans]
        result = audit(plans, stockroom_client(args.stockroom))
    except (OSError, HTTPException, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))
    return int(bool(result["pending_units"] or result["conflicting_boxes"]))


if __name__ == "__main__":
    sys.exit(main())
