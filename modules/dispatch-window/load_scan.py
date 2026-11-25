"""Create truck box labels and check a scanner's line-by-line record."""

import re


SCAN = re.compile(r"DW1/([a-zA-Z0-9_-]{1,80})/([a-zA-Z0-9_-]{1,80})/([1-9][0-9]{0,6})")


def labels_for(jobs):
    return [{**box, "code": f"DW1/{box['reservation_id']}/{box['shipment_id']}/{box['quantity']}"}
            for job in jobs for box in job["boxes"]]


def verify_load(jobs, scan_log):
    expected = {(box["reservation_id"], box["shipment_id"]): box for box in labels_for(jobs)}
    seen = {}
    issues = []
    for line, raw in enumerate(scan_log.splitlines(), 1):
        code = raw.strip()
        if not code:
            continue
        match = SCAN.fullmatch(code)
        issue = {"line": line, "code": code}
        if not match or int(match[3]) > 1_000_000:
            issues.append({**issue, "reason": "invalid_code"})
            continue
        pair = (match[1], match[2])
        box = expected.get(pair)
        if box is None:
            issues.append({**issue, "reason": "unexpected_box"})
        elif code != box["code"]:
            issues.append({**issue, "reason": "quantity_mismatch", "expected_quantity": box["quantity"]})
        elif pair in seen:
            issues.append({**issue, "reason": "duplicate_scan", "first_line": seen[pair]})
        else:
            seen[pair] = line
    missing = [box for pair, box in expected.items() if pair not in seen]
    return {"format": "dispatch-window.load-check.v1", "ready": not issues and not missing,
            "verified_boxes": len(seen), "verified_units": sum(expected[pair]["quantity"] for pair in seen),
            "missing": missing, "issues": issues}
