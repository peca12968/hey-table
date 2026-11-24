"""Plan the least opening cash top-up for an ordered list of known tenders."""
import argparse
from dataclasses import dataclass
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


@dataclass
class DrawerNode:
    after: list
    maximum: list[int]
    change: list


def extend_drawer(model, values, prior, tender, due, index):
    limits = [a+b for a,b in zip(prior.maximum, tender)]
    change, after = [], []
    for j, denomination in enumerate(values):
        coins = model.new_int_var(0, min(due // denomination, limits[j]), f"give_{index}_{j}")
        remaining = model.new_int_var(0, limits[j], f"left_{index}_{j}")
        model.add(remaining == prior.after[j] + tender[j] - coins)
        change.append(coins)
        after.append(remaining)
    model.add(amount(values, change) == due)
    return DrawerNode(after, limits, change)


def optimize_scenarios(values, opening, caps, scenarios):
    model = cp_model.CpModel()
    extra = [model.new_int_var(0, cap, f"extra_{j}") for j, cap in enumerate(caps)]
    initial = [base + top for base, top in zip(opening, extra)]
    # Node zero is the opening drawer. Edges depend only on observable price and tender.
    children = {}
    nodes = [DrawerNode(initial, [base + cap for base, cap in zip(opening, caps)], [])]
    paths, piece_totals = [], []
    worst_bound = 0
    for payments in scenarios:
        node, bound = 0, 0
        path = []
        for payment in payments:
            tender = payment["tender"]
            due = amount(values, tender) - payment["price"]
            if due < 0:
                return None
            edge = node, payment["price"], tuple(tender)
            if edge not in children:
                child = len(nodes)
                nodes.append(extend_drawer(model, values, nodes[node], tender, due, child))
                children[edge] = child
            node = children[edge]
            path.append(node)
            bound += due // values[0]
        paths.append(path)
        piece_totals.append(sum(sum(nodes[n].change) for n in path))
        worst_bound = max(worst_bound, bound)

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
    worst = model.new_int_var(0, worst_bound, "worst_pieces")
    for pieces in piece_totals:
        model.add(worst >= pieces)
    model.minimize(worst)
    status = solver.solve(model)
    if status != cp_model.OPTIMAL:
        raise ValueError(f"could not certify change count: {solver.status_name(status)}")
    top_counts = [solver.value(x) for x in extra]
    plans = []
    for payments, path, pieces in zip(scenarios, paths, piece_totals):
        steps = [{"id": row["id"], "change": [solver.value(x) for x in nodes[node].change],
                  "drawer": [solver.value(x) for x in nodes[node].after]} for row,node in zip(payments,path)]
        closing = steps[-1]["drawer"] if steps else [solver.value(x) for x in initial]
        plans.append({"steps":steps, "closing":closing, "piecesReturned":solver.value(pieces)})
    return {"topUp":top_counts, "topUpValue":minimum, "worstPiecesReturned":solver.value(worst),
            "scenarios":plans}


def guaranteed_prefix(scenarios, solve):
    horizon = max(map(len, scenarios))
    result = solve(scenarios)
    blocked_round = None
    if result is None:
        low, high = 0, horizon
        result = solve([[] for _ in scenarios])
        while high - low > 1:
            middle = (low + high) // 2
            candidate = solve([rows[:middle] for rows in scenarios])
            if candidate is None:
                high = middle
            else:
                low, result = middle, candidate
        horizon, blocked_round = low, high
    return result, horizon, blocked_round


def shared_plan(shifts, supply):
    """Maximize the guaranteed common horizon, then minimize top-up and worst shift piece count."""
    if not shifts:
        raise ValueError("provide at least one shift")
    values, opening, caps, payments = validate(shifts[0], supply)
    scenarios = [payments]
    for shift in shifts[1:]:
        _, other_opening, _, rows = validate(shift, supply)
        if other_opening != opening:
            raise ValueError("all scenarios must start with the same drawer")
        scenarios.append(rows)
    result, horizon, blocked_round = guaranteed_prefix(
        scenarios, lambda rows: optimize_scenarios(values, opening, caps, rows))
    for rows, planned in zip(scenarios, result["scenarios"]):
        planned["inputPayments"] = len(rows)
        for row, step in zip(rows, planned["steps"]):
            step.update(price=row["price"], tender=row["tender"])
    return {"denominations":values, "complete":blocked_round is None, "guaranteedRounds":horizon,
            "firstUnsupportedRound":blocked_round, **result}


def optimize(values, opening, caps, payments):
    result = optimize_scenarios(values, opening, caps, [payments])
    if result is None:
        return None
    return {"topUp":result["topUp"], "topUpValue":result["topUpValue"], **result["scenarios"][0]}


def plan(shift, supply):
    values, opening, caps, payments = validate(shift, supply)
    result, _, position = guaranteed_prefix([payments], lambda rows: optimize(values, opening, caps, rows[0]))
    blocked = None
    if position is not None:
        row = payments[position-1]
        due = amount(values, row["tender"]) - row["price"]
        blocked = {"id":row["id"], "position":position, "tenderMinusPrice":due,
                   "reason":"underpaid" if due < 0 else "no_exact_change"}
    return {"denominations":values, "complete":blocked is None, "firstBlocked":blocked, **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shift", type=Path)
    parser.add_argument("supply", type=Path)
    parser.add_argument("--alternative", type=Path, action="append", help="another possible shift (repeatable)")
    args = parser.parse_args()
    try:
        data = [json.loads(path.read_text(encoding="utf-8-sig")) for path in (args.shift, args.supply)]
        if args.alternative:
            alternatives = [json.loads(path.read_text(encoding="utf-8-sig")) for path in args.alternative]
            result = shared_plan([data[0], *alternatives], data[1])
            for path, scenario in zip([args.shift,*args.alternative],result["scenarios"]):
                scenario["source"] = path.name
        else:
            result = plan(*data)
    except (OSError, ValueError, OverflowError, TypeError) as exc:
        parser.exit(2, f"float-plan: {exc}\n")
    print(json.dumps(result, indent=2))
    return 0 if result["complete"] else 3


if __name__ == "__main__":
    sys.exit(main())
