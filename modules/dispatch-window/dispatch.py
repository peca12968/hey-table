"""Plan the highest-volume dispatch from a set of Stockroom holds at one packing station."""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys


MAX_ORDERS = 17
MAX_INTEGER = 2**53 - 1
KEY = re.compile(r"[a-zA-Z0-9_-]{1,80}")


def integer(value, label, low=0, high=MAX_INTEGER):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{label} must be an integer between {low} and {high}")
    return value


def key(value):
    if not isinstance(value, str) or not KEY.fullmatch(value):
        raise ValueError("invalid Stockroom ID")
    return value


@dataclass(frozen=True)
class Job:
    reservation: str
    ready: int
    duration: int
    deadline: int
    units: int
    boxes: tuple


def indexed(rows, field):
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("expected a list of objects")
    result = {}
    for row in rows:
        lookup = key(row[field])
        if lookup in result:
            raise ValueError(f"repeated ID {lookup}")
        result[lookup] = row
    return result


def reconcile_boxes(boxes, shipped, order_id, duration):
    recorded = []
    remaining = []
    conflicts = []
    timings = {}
    if any("pack_ms" in box for box in boxes.values()):
        timings = {
            box_id: integer(box.get("pack_ms"), f"{order_id}/{box_id}.pack_ms", 1)
            for box_id, box in boxes.items()
        }
        if sum(timings.values()) > duration:
            raise ValueError(f"{order_id}: box packing times exceed order.pack_ms")
    for box_id, box in sorted(boxes.items()):
        qty = integer(box["quantity"], "quantity", 1, 1_000_000)
        if box_id not in shipped:
            remaining.append((box_id, qty))
            continue
        actual = integer(shipped[box_id].get("dispatched"), f"{order_id}/{box_id}.dispatched", 1, 1_000_000)
        if actual != qty:
            conflicts.append({"reservation_id": order_id, "shipment_id": box_id,
                              "planned_quantity": qty, "recorded_quantity": actual})
            continue
        recorded.append({"reservation_id": order_id, "shipment_id": box_id, "quantity": actual})
        duration -= timings.get(box_id, 0)
    return tuple(remaining), recorded, conflicts, duration


def collect(document, start, cutoff, resume):
    orders = indexed(document["work"], "reservation_id")
    if not isinstance(document["holds"], list):
        raise ValueError("expected a list of Stockroom packing statements")
    statements = [
        {"id": row["reservation"]["id"], "snapshot": row} for row in document["holds"]
    ]
    holds = indexed(statements, "id")
    if len(orders) > MAX_ORDERS or orders.keys() != holds.keys():
        raise ValueError(
            f"provide one Stockroom snapshot per order, up to {MAX_ORDERS} orders"
        )
    jobs = []
    omitted = {}
    already_dispatched = []
    shipment_conflicts = []
    for order_id, order in sorted(orders.items()):
        statement = holds[order_id]["snapshot"]
        available = statement["reservation"]
        shipped = indexed(statement["boxes"], "shipment_id")
        state = available["state"]
        if state not in ("held", "released", "fulfilled", "expired"):
            raise ValueError(f"{order_id}: unknown hold state")
        held = integer(available["held"], f"{order_id}.held")
        expires = available["expires_at_ms"]
        if expires is not None:
            expires = integer(expires, f"{order_id}.expires_at_ms")
        ready = max(start, integer(order["ready_ms"], f"{order_id}.ready_ms"))
        duration = integer(order["pack_ms"], f"{order_id}.pack_ms", 1)
        boxes = indexed(order["boxes"], "shipment_id")
        if not 1 <= len(boxes) <= 100:
            raise ValueError(f"{order_id}: expected 1 to 100 boxes")
        if resume:
            rows, confirmed, conflicts, duration = reconcile_boxes(boxes, shipped, order_id, duration)
            already_dispatched.extend(confirmed)
            shipment_conflicts.extend(conflicts)
            if conflicts or not rows:
                omitted[order_id] = "shipment_quantity_conflict" if conflicts else "already_dispatched"
                continue
        else:
            rows = tuple(
                (box_id, integer(box["quantity"], "quantity", 1, 1_000_000))
                for box_id, box in sorted(boxes.items())
            )
        units = sum(quantity for _, quantity in rows)
        deadline = cutoff if expires is None else min(expires, cutoff)
        if state != "held" or (expires is not None and expires <= start):
            omitted[order_id] = "hold_closed"
        elif not resume and boxes.keys() & shipped.keys():
            omitted[order_id] = "shipment_id_already_used"
        elif held < units:
            omitted[order_id] = "insufficient_hold"
        elif ready + duration >= deadline:
            omitted[order_id] = "cannot_finish_before_deadline"
        else:
            jobs.append(Job(order_id, ready, duration, deadline, units, rows))
    return jobs, omitted, already_dispatched, shipment_conflicts


def optimize(jobs, start):
    """Return indices in packing order. Each subset needs only its earliest finish."""
    full = (1 << len(jobs)) - 1
    finish = {0: start}
    parent = {}
    units = {0: 0}
    best = 0
    for subset in range(full + 1):
        if subset not in finish:
            continue
        at = finish[subset]
        if (units[subset], subset.bit_count(), -at) > (
            units[best],
            best.bit_count(),
            -finish[best],
        ):
            best = subset
        remaining = full ^ subset
        while remaining:
            bit = remaining & -remaining
            remaining ^= bit
            job = jobs[bit.bit_length() - 1]
            end = max(at, job.ready) + job.duration
            combined = subset | bit
            if end < job.deadline and (
                combined not in finish or end < finish[combined]
            ):
                finish[combined] = end
                parent[combined] = bit
                units[combined] = units[subset] + job.units
    route = []
    while best:
        bit = parent[best]
        route.append(bit.bit_length() - 1)
        best ^= bit
    return route[::-1]


def plan(document, *, resume=False):
    start = integer(document["start_ms"], "start_ms")
    if resume and "captured_at_ms" not in document:
        raise ValueError("--resume requires the captured_at_ms from a Stockroom packing snapshot")
    if "captured_at_ms" in document:
        captured = integer(document["captured_at_ms"], "captured_at_ms")
        if start < captured:
            raise ValueError("start_ms predates the packing snapshot")
    cutoff = integer(document["cutoff_ms"], "cutoff_ms", start + 1)
    jobs, omitted, confirmed, conflicts = collect(document, start, cutoff, resume)
    selected = optimize(jobs, start)
    scheduled = []
    at = start
    for index in selected:
        job = jobs[index]
        begins = max(at, job.ready)
        at = begins + job.duration
        scheduled.append(
            {
                "reservation_id": job.reservation,
                "pack_start_ms": begins,
                "dispatch_ms": at,
                "deadline_ms": job.deadline,
                "units": job.units,
                "dispatch": {
                    "boxes": [
                        {
                            "reservation_id": job.reservation,
                            "shipment_id": box,
                            "quantity": qty,
                        }
                        for box, qty in job.boxes
                    ]
                },
            }
        )
    chosen = {item["reservation_id"] for item in scheduled}
    for job in jobs:
        if job.reservation not in chosen:
            omitted[job.reservation] = "not_selected"
    report = {
        "start_ms": start,
        "cutoff_ms": cutoff,
        "ship_units": sum(item["units"] for item in scheduled),
        "scheduled": scheduled,
        "omitted": [
            {"reservation_id": order, "reason": reason}
            for order, reason in sorted(omitted.items())
        ],
    }
    if resume:
        report["already_dispatched"] = confirmed
        report["shipment_conflicts"] = conflicts
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--resume", action="store_true", help="Replan boxes that have not been dispatched")
    args = parser.parse_args(argv)
    try:
        report = plan(json.loads(args.input.read_text(encoding="utf-8-sig")), resume=args.resume)
    except (OSError, TypeError, ValueError, KeyError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
