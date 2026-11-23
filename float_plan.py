"""Plan the least opening cash top-up for an ordered list of known tenders."""
import argparse
import json
from pathlib import Path
import sys

from ortools.sat.python import cp_model


def vector(value, size, name):
    if (not isinstance(value, list) or len(value) != size or
            any(type(n) is not int or n < 0 for n in value)):
        raise ValueError(f"{name}: expected {size} nonnegative integer counts")
    return value


def amount(denominations, counts):
    return sum(d * count for d, count in zip(denominations, counts, strict=True))


def validate(shift, supply):
    if not isinstance(shift, dict) or not isinstance(supply, dict):
        raise ValueError("shift and supply must be objects")
    values = shift.get("denominations")
    if (not isinstance(values, list) or not values or any(type(d) is not int or d < 1 for d in values)
            or values != sorted(set(values))):
        raise ValueError("expected positive ascending distinct denominations")
    n = len(values)
    if vector(supply.get("denominations"), n, "supply denominations") != values:
        raise ValueError("supply uses different denominations")
    opening = vector(shift.get("opening"), n, "opening")
    vector(shift.get("reserve"), n, "reserve")
    caps = vector(supply.get("available"), n, "available")
    payments = shift.get("payments")
    if not isinstance(payments, list):
        raise ValueError("expected a payment list")
    seen = set()
    for row in payments:
        if not isinstance(row, dict):
            raise ValueError("expected a payment object")
        key = row.get("id")
        if not isinstance(key, str) or not key.strip() or key in seen:
            raise ValueError("expected unique nonblank payment IDs")
        seen.add(key)
        if type(row.get("price")) is not int or row["price"] < 0:
            raise ValueError(f"{key}: invalid price")
        vector(row.get("tender"), n, key)
    return values, opening, caps, payments


def optimize(values, opening, caps, payments):
    model = cp_model.CpModel()
    extra = [model.new_int_var(0, cap, f"extra_{j}") for j, cap in enumerate(caps)]
    drawer = [base + top for base, top in zip(opening, extra)]
    maximum = [base + cap for base, cap in zip(opening, caps)]
    rows = []
    for i, payment in enumerate(payments):
        tender = payment["tender"]
        due = amount(values, tender) - payment["price"]
        if due < 0:
            return None
        change, after = [], []
        for j, denomination in enumerate(values):
            maximum[j] += tender[j]
            coins = model.new_int_var(0, min(due // denomination, maximum[j]), f"give_{i}_{j}")
            remaining = model.new_int_var(0, maximum[j], f"left_{i}_{j}")
            model.add(remaining == drawer[j] + tender[j] - coins)
            change.append(coins)
            after.append(remaining)
        model.add(amount(values, change) == due)
        rows.append((change, after))
        drawer = after

    # Solve in two stages so no arbitrary weight can exchange cash value for fewer coins.
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    top_up = amount(values, extra)
    model.minimize(top_up)
    status = solver.solve(model)
    if status == cp_model.INFEASIBLE:
        return None
    if status != cp_model.OPTIMAL:
        raise ValueError(f"could not certify opening float: {solver.status_name(status)}")
    minimum = solver.value(top_up)
    model.add(top_up == minimum)
    model.minimize(sum(sum(change) for change, _ in rows))
    status = solver.solve(model)
    if status != cp_model.OPTIMAL:
        raise ValueError(f"could not certify change count: {solver.status_name(status)}")
    top_counts = [solver.value(x) for x in extra]
    steps = []
    for payment, (change, after) in zip(payments, rows):
        steps.append({"id": payment["id"], "change": [solver.value(x) for x in change],
                      "drawer": [solver.value(x) for x in after]})
    return {"topUp":top_counts, "topUpValue":minimum, "piecesReturned":sum(sum(r["change"]) for r in steps),
            "steps":steps, "closing":[solver.value(x) for x in drawer]}


def plan(shift, supply):
    values, opening, caps, payments = validate(shift, supply)
    result = optimize(values, opening, caps, payments)
    blocked = None
    if result is None:
        # If a prefix cannot be served, adding later customers cannot repair it.
        low, high = 0, len(payments)
        result = optimize(values, opening, caps, [])
        while high - low > 1:
            middle = (low + high) // 2
            candidate = optimize(values, opening, caps, payments[:middle])
            if candidate is None:
                high = middle
            else:
                low, result = middle, candidate
        row = payments[low]
        due = amount(values, row["tender"]) - row["price"]
        blocked = {"id":row["id"], "position":low+1, "tenderMinusPrice":due,
                   "reason":"underpaid" if due < 0 else "no_exact_change"}
    return {"denominations":values, "complete":blocked is None, "firstBlocked":blocked, **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shift", type=Path)
    parser.add_argument("supply", type=Path)
    args = parser.parse_args()
    try:
        data = [json.loads(path.read_text(encoding="utf-8-sig")) for path in (args.shift, args.supply)]
        result = plan(*data)
    except (OSError, ValueError, OverflowError, TypeError) as exc:
        parser.exit(2, f"float-plan: {exc}\n")
    print(json.dumps(result, indent=2))
    return 0 if result["complete"] else 3


if __name__ == "__main__":
    sys.exit(main())
