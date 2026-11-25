"""Plan the highest-volume dispatch from Stockroom holds at one or two packing stations."""

import argparse
from bisect import bisect_right
from dataclasses import dataclass
import json
from operator import itemgetter
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


def station_pauses(value, stations):
    if not isinstance(value, list) or len(value) != stations:
        raise ValueError("station_pauses must contain one interval list per packing station")
    calendars = []
    for index, rows in enumerate(value):
        if not isinstance(rows, list):
            raise ValueError(f"station_pauses[{index}] must be a list")
        intervals = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError(f"station_pauses[{index}] must contain objects")
            begin = integer(row.get("start_ms"), "pause.start_ms")
            end = integer(row.get("end_ms"), "pause.end_ms", begin + 1)
            intervals.append((begin, end))
        merged = []
        for begin, end in sorted(intervals):
            if merged and begin <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((begin, end))
        calendars.append(tuple(merged))
    return calendars


def packing_start(at, job, pauses):
    begin = max(at, job.ready)
    first = bisect_right(pauses, begin, key=itemgetter(1)) if pauses else 0
    for index in range(first, len(pauses)):
        blocked, resumes = pauses[index]
        if begin + job.duration <= blocked:
            break
        begin = resumes
    return begin


def collect(document, start, cutoff, resume, stations):
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
        else:
            job = Job(order_id, ready, duration, deadline, units, rows)
            if any(packing_start(at, job, pauses) + duration < deadline for at, pauses in stations):
                jobs.append(job)
            else:
                omitted[order_id] = "cannot_finish_before_deadline"
    return jobs, omitted, already_dispatched, shipment_conflicts


def packing_states(jobs, start, pauses=()):
    """Find the earliest feasible finish for every subset on a single station."""
    full = (1 << len(jobs)) - 1
    finish = {0: start}
    parent = {}
    units = {0: 0}
    for subset in range(full + 1):
        if subset not in finish:
            continue
        at = finish[subset]
        remaining = full ^ subset
        while remaining:
            bit = remaining & -remaining
            remaining ^= bit
            job = jobs[bit.bit_length() - 1]
            end = packing_start(at, job, pauses) + job.duration
            combined = subset | bit
            if end < job.deadline and (
                combined not in finish or end < finish[combined]
            ):
                finish[combined] = end
                parent[combined] = bit
                units[combined] = units[subset] + job.units
    return finish, parent, units


def packing_order(parent, subset):
    route = []
    while subset:
        bit = parent[subset]
        route.append(bit.bit_length() - 1)
        subset ^= bit
    return route[::-1]


def optimize(jobs, start, pauses=()):
    """Return indices in packing order for a single station."""
    finish, parent, units = packing_states(jobs, start, pauses)
    best = max(finish, key=lambda mask: (units[mask], mask.bit_count(), -finish[mask], -mask))
    return packing_order(parent, best)


def optimize_parallel(jobs, start, second_start=None, *, first_pauses=(), second_pauses=()):
    """Choose two disjoint feasible routes without enumerating all pairs of subsets."""
    second_start = start if second_start is None else second_start
    identical = start == second_start and first_pauses == second_pauses
    first_finish, first_parent, first_units = packing_states(jobs, start, first_pauses)
    second_finish, second_parent, second_units = (
        (first_finish, first_parent, first_units) if identical
        else packing_states(jobs, second_start, second_pauses)
    )
    limit = 1 << len(jobs)
    scores = {mask: (second_units[mask], mask.bit_count(), -at, -mask) for mask, at in second_finish.items()}
    best_subset = [mask if mask in second_finish else 0 for mask in range(limit)]
    # After processing each bit, the best route may also omit that order.
    for index in range(len(jobs)):
        bit = 1 << index
        for block in range(0, limit, 2 * bit):
            for mask in range(block + bit, block + 2 * bit):
                candidate = best_subset[mask ^ bit]
                if scores[candidate] > scores[best_subset[mask]]:
                    best_subset[mask] = candidate

    def score_pair(pair):
        left, right = pair
        latest = max(first_finish[left] if left else 0, second_finish[right] if right else 0)
        return (first_units[left] + second_units[right], (left | right).bit_count(), -latest,
                -min(left, right), -max(left, right))

    full = limit - 1
    pair = max(((left, best_subset[full ^ left]) for left in first_finish), key=score_pair)
    left, right = sorted(pair, key=lambda mask: (mask == 0, mask)) if identical else pair
    return [packing_order(first_parent, left), packing_order(second_parent, right)]


def plan(document, *, resume=False, stations=1):
    stations = integer(stations, "stations", 1, 2)
    start = integer(document["start_ms"], "start_ms")
    if resume and "captured_at_ms" not in document:
        raise ValueError("--resume requires the captured_at_ms from a Stockroom packing snapshot")
    if "captured_at_ms" in document:
        captured = integer(document["captured_at_ms"], "captured_at_ms")
        if start < captured:
            raise ValueError("start_ms predates the packing snapshot")
    cutoff = integer(document["cutoff_ms"], "cutoff_ms", start + 1)
    availability = document.get("station_ready_ms", [start] * stations)
    if not isinstance(availability, list) or len(availability) != stations:
        raise ValueError("station_ready_ms must contain one timestamp per packing station")
    station_ready = [integer(value, f"station_ready_ms[{index}]", start)
                     for index, value in enumerate(availability)]
    pauses = station_pauses(document.get("station_pauses", [[] for _ in range(stations)]), stations)
    jobs, omitted, confirmed, conflicts = collect(document, start, cutoff, resume, tuple(zip(station_ready, pauses)))
    routes = ([optimize(jobs, station_ready[0], pauses[0])] if stations == 1 else
              optimize_parallel(jobs, *station_ready, first_pauses=pauses[0], second_pauses=pauses[1]))
    scheduled = []
    for station, route in enumerate(routes, 1):
        at = station_ready[station - 1]
        for index in route:
            job = jobs[index]
            begins = packing_start(at, job, pauses[station - 1])
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
            if stations == 2:
                scheduled[-1]["station"] = station
    if stations == 2:
        scheduled.sort(key=lambda row: (row["dispatch_ms"], row["station"]))
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
    if stations == 2:
        report["stations"] = stations
    if "station_ready_ms" in document:
        report["station_ready_ms"] = station_ready
    if "station_pauses" in document:
        report["station_pauses"] = [[{"start_ms": begin, "end_ms": end} for begin, end in rows]
                                   for rows in pauses]
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--resume", action="store_true", help="Replan boxes that have not been dispatched")
    parser.add_argument("--stations", type=int, choices=(1, 2), default=1, help="Number of packing stations")
    args = parser.parse_args(argv)
    try:
        report = plan(json.loads(args.input.read_text(encoding="utf-8-sig")), resume=args.resume, stations=args.stations)
    except (OSError, TypeError, ValueError, KeyError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
