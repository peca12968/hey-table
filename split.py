"""Split a Hey Table receipt in whole currency units, preserving line and diner quotas."""
import argparse
from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
import json
from math import floor
from pathlib import Path


@dataclass
class Edge:
    to: int
    reverse: int
    capacity: int
    total_cost: Fraction
    item_cost: Fraction


def connect(graph, start, end, capacity, total_cost=0, item_cost=0):
    forward = Edge(end, len(graph[end]), capacity, total_cost, item_cost)
    reverse = Edge(start, len(graph[start]), 0, -total_cost, -item_cost)
    graph[start].append(forward)
    graph[end].append(reverse)
    return forward


def assign_units(graph, source, sink, units):
    # Every augmenting path contains a one-unit dish-to-diner edge. Reverse edges
    # allow changing an earlier choice when a later dish has fewer eligible diners.
    for _ in range(units):
        distance = [None] * len(graph)
        previous = [None] * len(graph)
        distance[source] = (0, 0)
        for _ in range(len(graph) - 1):
            changed = False
            for node, edges in enumerate(graph):
                if distance[node] is None:
                    continue
                for edge in edges:
                    if not edge.capacity:
                        continue
                    cost = (distance[node][0] + edge.total_cost, distance[node][1] + edge.item_cost)
                    if distance[edge.to] is None or cost < distance[edge.to]:
                        distance[edge.to] = cost
                        previous[edge.to] = (node, edge)
                        changed = True
            if not changed:
                break
        if previous[sink] is None:
            raise RuntimeError("No rounding path satisfies the receipt quotas")
        node = sink
        while node != source:
            parent, edge = previous[node]
            edge.capacity -= 1
            graph[node][edge.reverse].capacity += 1
            node = parent


def integer(value, minimum, label):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def split(receipt, shares):
    if not isinstance(shares, dict) or not isinstance(receipt["items"], list) or not receipt["items"]:
        raise ValueError("Expected receipt items and per-dish share weights")
    amounts, exact, personal = {}, {}, Counter()
    for line in receipt["items"]:
        dish = line["id"]
        if not isinstance(dish, str) or not dish.strip() or dish in amounts:
            raise ValueError(f"Invalid or repeated dish ID {dish}")
        amounts[dish] = integer(line["price"], 0, "price") * integer(line["qty"], 1, "qty")
        weights = shares.get(dish)
        if not isinstance(weights, dict) or not weights:
            raise ValueError(f"{dish}: expected at least one diner")
        for person, weight in weights.items():
            if not isinstance(person, str) or not person.strip():
                raise ValueError("Diner name cannot be empty")
            integer(weight, 1, "share weight")
        denominator = sum(weights.values())
        exact[dish] = {p: Fraction(amounts[dish] * w, denominator) for p, w in weights.items()}
        personal.update(exact[dish])
    if set(shares) != set(amounts):
        raise ValueError("Share weights must match the receipt dishes")
    if integer(receipt["total"], 0, "receipt total") != sum(amounts.values()):
        raise ValueError("Receipt total differs from the sum of its items")

    dishes, diners = sorted(amounts), sorted(personal)
    source = 0
    people = {p: len(dishes) + i + 1 for i, p in enumerate(diners)}
    pool, sink = len(dishes) + len(diners) + 1, len(dishes) + len(diners) + 2
    graph = [[] for _ in range(sink + 1)]
    base_totals, lines, choices = Counter(), {}, {}
    extra = 0
    for row, dish in enumerate(dishes, 1):
        lines[dish] = {p: floor(exact[dish][p]) for p in sorted(exact[dish])}
        base_totals.update(lines[dish])
        remaining = amounts[dish] - sum(lines[dish].values())
        extra += remaining
        connect(graph, source, row, remaining)
        for p, base in lines[dish].items():
            fraction = exact[dish][p] - base
            if fraction:
                choices[dish, p] = connect(graph, row, people[p], 1, item_cost=1 - 2 * fraction)

    mandatory = 0
    for p, node in people.items():
        minimum = floor(personal[p])
        required = minimum - base_totals[p]
        connect(graph, node, sink, required)
        mandatory += required
        fraction = personal[p] - minimum
        if fraction:
            connect(graph, node, pool, 1, total_cost=1 - 2 * fraction)
    # All direct edges to the sink must fill. Only the remaining units fit via the pool.
    connect(graph, pool, sink, extra - mandatory)
    assign_units(graph, source, sink, extra)
    totals = Counter(base_totals)
    for (dish, p), edge in choices.items():
        if edge.capacity == 0:
            lines[dish][p] += 1
            totals[p] += 1
    return {"total": receipt["total"], "lines": lines,
            "diners": {p: {"exact": str(personal[p]), "pay": totals[p]} for p in diners}}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key {key}")
        result[key] = value
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    parser.add_argument("shares", type=Path)
    args = parser.parse_args()
    try:
        inputs = [json.loads(p.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
                  for p in (args.receipt, args.shares)]
        print(json.dumps(split(*inputs), indent=2, ensure_ascii=False))
    except (OSError, TypeError, KeyError, ValueError) as error:
        parser.exit(2, f"{error}\n")
