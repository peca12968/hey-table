"""Reconcile Till Change sales against cash transfers and physical drawer counts."""
import argparse
import json
from pathlib import Path
import sys


def natural(value, label):
    if type(value) is not int or value < 0:
        raise ValueError(f"{label}: expected a nonnegative integer")
    return value


def identifier(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}: expected a nonempty ID")
    return value


def counts(raw, width, label):
    if not isinstance(raw, list) or len(raw) != width:
        raise ValueError(f"{label}: expected {width} denomination counts")
    return [natural(n, label) for n in raw]


def value(coins, denominations):
    return sum(n * d for n, d in zip(coins, denominations, strict=True))


def subtract(left, right):
    return [a - b for a, b in zip(left, right, strict=True)]


def add(left, right):
    return [a + b for a, b in zip(left, right, strict=True)]


def sale_movement(payment, receipt, denominations):
    ref = payment["id"]
    width = len(denominations)
    tender = counts(payment["tender"], width, ref)
    change = counts(receipt["change"], width, ref)
    paid = value(tender, denominations)
    price = natural(payment["price"], ref)
    if paid != natural(receipt["paid"], ref):
        raise ValueError(f"{ref}: tender total differs from receipt")
    state = receipt["status"]
    if state == "accepted":
        delta = subtract(tender, change)
        if value(delta, denominations) != price:
            raise ValueError(f"{ref}: collected value differs from sale price")
        return delta
    if not any(change) and ((state == "underpaid" and paid < price) or
                            (state == "no_exact_change" and paid > price)):
        return [0] * width
    raise ValueError(f"{ref}: invalid payment outcome")


def register_replay(shift, replay):
    denominations = shift["denominations"]
    if not isinstance(denominations, list) or not denominations or any(
            type(d) is not int or d < 1 for d in denominations):
        raise ValueError("Denominations must be positive integers")
    width = len(denominations)
    if denominations != sorted(set(denominations)) or counts(replay["denominations"], width, "receipts") != denominations:
        raise ValueError("Denominations must be unique, ascending and match the receipt file")
    opening = counts(shift["opening"], width, "opening")
    register = opening.copy()
    receipts = {}
    sales = rejected = 0
    if not isinstance(shift["payments"], list) or not isinstance(replay["receipts"], list):
        raise ValueError("Expected lists of payments and receipts")
    for pay, receipt in zip(shift["payments"], replay["receipts"], strict=True):
        ref = identifier(pay["id"], "payment ID")
        if ref in receipts or receipt["id"] != ref:
            raise ValueError(f"{ref}: duplicate or misordered receipt")
        delta = sale_movement(pay, receipt, denominations)
        register = add(register, delta)
        if register != counts(receipt["drawer"], width, ref):
            raise ValueError(f"{ref}: register movement differs from receipt")
        receipts[ref] = delta
        sales += value(delta, denominations)
        rejected += receipt["status"] != "accepted"
    if register != counts(replay["closing"], width, "register closing"):
        raise ValueError("Closing drawer differs from the last receipt")
    return denominations, opening, receipts, sales, rejected


def physical_count(ref, anchor, expected, actual, denominations, previous):
    delta = subtract(actual, expected)
    net = value(delta, denominations)
    status = "balanced"
    if net:
        status = "short" if net < 0 else "over"
    elif any(delta):
        status = "denomination_mismatch"
    baseline = previous["difference"] if previous else [0] * len(expected)
    return {"id": ref, "after": anchor, "previous_count": previous["id"] if previous else None,
            "expected": expected, "counted": actual, "difference": delta,
            "change_since_previous_count": subtract(delta, baseline),
            "expected_twd": value(expected, denominations), "counted_twd": value(actual, denominations),
            "difference_twd": net, "status": status}


def reconcile(shift, replay, sheet):
    denominations, opening, receipts, sales, rejected = register_replay(shift, replay)
    if sheet["currency"] != "TWD" or not isinstance(sheet["events"], list):
        raise ValueError("Expected a TWD list of cash transfers and counts")
    sequence = {ref: i for i, ref in enumerate(receipts, start=1)}
    deltas = list(receipts.values())
    expected = opening.copy()
    seen = {}
    checks = []
    deposited = removed = index = 0
    closed = False
    for event in sheet["events"]:
        if not isinstance(event, dict) or set(event) != {"id", "kind", "after", "counts"}:
            raise ValueError("Expected exactly id, kind, after and counts on each event")
        ref = identifier(event["id"], "event ID")
        kind = event["kind"]
        coins = counts(event["counts"], len(denominations), ref)
        anchor = event["after"]
        if anchor is not None:
            identifier(anchor, "receipt ID")
        if ref in seen:
            if seen[ref] != event:
                raise ValueError(f"{ref}: conflicting repeated event")
            continue
        seen[ref] = event
        target = 0 if anchor is None else sequence.get(anchor)
        if target is None or target < index or closed:
            raise ValueError(f"{ref}: unknown, out-of-order or closed event position")
        for delta in deltas[index:target]:
            expected = add(expected, delta)
            if min(expected) < 0:
                raise ValueError(f"{ref}: intervening sale used unavailable denominations")
        index = target
        if kind in ("add", "remove"):
            total = value(coins, denominations)
            if not total:
                raise ValueError(f"{ref}: empty cash transfer")
            if kind == "add":
                deposited += total
                expected = add(expected, coins)
            else:
                removed += total
                expected = subtract(expected, coins)
                if min(expected) < 0:
                    raise ValueError(f"{ref}: transfer exceeds drawer quantities")
        elif kind in ("count", "close"):
            if kind == "close" and target != len(receipts):
                raise ValueError(f"{ref}: close must cover all receipts")
            checks.append(physical_count(ref, anchor, expected, coins, denominations, checks[-1] if checks else None))
            closed = kind == "close"
        else:
            raise ValueError(f"{ref}: unknown event kind {kind}")
    if not closed:
        raise ValueError("Missing closing physical count")
    return {"currency": "TWD", "denominations": denominations, "opening_twd": value(opening, denominations),
            "accepted_sales_twd": sales, "rejected_payments": rejected, "added_twd": deposited,
            "removed_twd": removed, "checks": checks, "closing_status": checks[-1]["status"]}


def unique_fields(pairs):
    result = {}
    for key, item in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field {key}")
        result[key] = item
    return result


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_fields)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("shift", "receipts", "sheet"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--strict", action="store_true", help="return 3 if any physical count differs")
    args = parser.parse_args()
    try:
        report = reconcile(read(args.shift), read(args.receipts), read(args.sheet))
    except (OSError, KeyError, ValueError, TypeError) as exc:
        parser.exit(2, f"{exc}\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 3 if args.strict and any(c["status"] != "balanced" for c in report["checks"]) else 0


if __name__ == "__main__":
    sys.exit(main())
