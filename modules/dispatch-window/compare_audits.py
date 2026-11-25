"""Compare Stockroom audit snapshots and report changes for shared boxes."""

import argparse
import json
from pathlib import Path
import sys

from audit import CONFLICTS, RESERVATION_STATES, box_status, totals
from dispatch import integer, key


def normalize_snapshot(report):
    if report["format"] != "dispatch-window.audit.v1":
        raise ValueError("expected a Dispatch Window audit snapshot")
    captured = integer(report["captured_at_ms"], "captured_at_ms")
    plan_count = integer(report["plan_count"], "plan_count", 1)
    if not isinstance(report["boxes"], list):
        raise ValueError("audit boxes must be a list")
    boxes = {}
    for row in report["boxes"]:
        reservation, shipment = key(row["reservation_id"]), key(row["shipment_id"])
        pair = (reservation, shipment)
        if pair in boxes:
            raise ValueError(f"{reservation}/{shipment}: duplicated box")
        plans = row["plans"]
        if not isinstance(plans, list) or not plans:
            raise ValueError(f"{reservation}/{shipment}: expected at least one plan reference")
        references = [
            {"plan": integer(ref["plan"], "plan", 1, plan_count),
             "quantity": integer(ref["quantity"], "quantity", 1, 1_000_000)}
            for ref in plans
        ]
        if len({ref["plan"] for ref in references}) != len(references):
            raise ValueError(f"{reservation}/{shipment}: duplicated plan reference")
        references.sort(key=lambda ref: ref["plan"])
        recorded, restocked = row["recorded_units"], row["restocked_units"]
        if recorded is not None:
            recorded = integer(recorded, "recorded_units", 1, 1_000_000)
            restocked = integer(restocked, "restocked_units", high=recorded)
        elif restocked is not None:
            raise ValueError(f"{reservation}/{shipment}: return recorded without dispatch")
        state = row["reservation_state"]
        status = box_status(references, recorded)
        if state not in RESERVATION_STATES or row["status"] != status:
            raise ValueError(f"{reservation}/{shipment}: invalid reservation or audit status")
        boxes[pair] = {"plans": references, "recorded_units": recorded, "restocked_units": restocked,
                       "reservation_state": state, "status": status}
    if any(integer(report[name], name) != value for name, value in totals(boxes.values()).items()):
        raise ValueError("audit summary does not match its boxes")
    return captured, boxes


def compare_audits(first, second):
    before_ms, before = normalize_snapshot(first)
    after_ms, after = normalize_snapshot(second)
    if after_ms <= before_ms:
        raise ValueError("the second snapshot must be captured after the first")
    comparable = before.keys() & after.keys()
    added = after.keys() - before.keys()
    removed = before.keys() - after.keys()
    dispatched = restocked = resolved = new = 0
    changes = []
    for reservation, shipment in sorted(before.keys() | after.keys()):
        pair = (reservation, shipment)
        old, current = before.get(pair), after.get(pair)
        if old == current:
            continue
        dispatched_delta = restocked_delta = None
        if pair in comparable:
            known_dispatch = old["recorded_units"]
            old_returns = old["restocked_units"] or 0
            new_returns = current["restocked_units"] or 0
            if (known_dispatch is not None and known_dispatch != current["recorded_units"]) or new_returns < old_returns:
                raise ValueError(f"{reservation}/{shipment}: later Stockroom history contradicts the first snapshot")
            dispatched_delta = (current["recorded_units"] or 0) - (known_dispatch or 0)
            restocked_delta = new_returns - old_returns
            dispatched += dispatched_delta
            restocked += restocked_delta
            resolved += old["status"] in CONFLICTS and current["status"] not in CONFLICTS
            new += old["status"] not in CONFLICTS and current["status"] in CONFLICTS
        changes.append({"reservation_id": reservation, "shipment_id": shipment, "before": old, "after": current,
                        "dispatched_delta": dispatched_delta, "restocked_delta": restocked_delta})
    return {"format": "dispatch-window.audit-difference.v1", "before_ms": before_ms, "after_ms": after_ms,
            "comparable_boxes": len(comparable), "added_boxes": len(added), "removed_boxes": len(removed),
            "new_dispatched_units": dispatched, "new_restocked_units": restocked,
            "resolved_conflicts": resolved, "new_conflicts": new, "changes": changes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path, help="Earlier Stockroom audit JSON")
    parser.add_argument("after", type=Path, help="Later Stockroom audit JSON")
    args = parser.parse_args(argv)
    try:
        before = json.loads(args.before.read_text(encoding="utf-8-sig"))
        after = json.loads(args.after.read_text(encoding="utf-8-sig"))
        result = compare_audits(before, after)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
