"""Turn a Hey Table kitchen snapshot into a whole-batch prep and purchasing list."""
import argparse
from bisect import bisect_right
from collections import Counter
from contextlib import closing
from graphlib import CycleError, TopologicalSorter
import json
from pathlib import Path
import sqlite3


def integer(value, minimum, label):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label} must be an integer >= {minimum}")
    return value


def mapping(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def quantities(value, components, minimum, label):
    for key, amount in mapping(value, label).items():
        if key not in components:
            raise ValueError(f"{label}: unknown component {key}")
        integer(amount, minimum, f"{label}.{key}")
    return value


def catalog(book):
    components = mapping(book["components"], "components")
    graph = TopologicalSorter()
    for key, item in components.items():
        mapping(item, key)
        if not isinstance(item.get("unit"), str) or not item["unit"].strip():
            raise ValueError(f"{key}: missing unit")
        graph.add(key)
        if "inputs" in item:
            if "pack" in item or not item["inputs"]:
                raise ValueError(f"{key}: a prep batch needs inputs and a yield")
            integer(item["yield"], 1, f"{key}.yield")
            for part in quantities(item["inputs"], components, 1, key):
                graph.add(part, key)
        else:
            if "yield" in item:
                raise ValueError(f"{key}: yield requires batch inputs")
            integer(item["pack"], 1, f"{key}.pack")
    try:
        order = list(graph.static_order())
    except CycleError as error:
        raise ValueError("Cyclic prep recipe: " + " -> ".join(error.args[1])) from error
    revisions = {}
    for dish, versions in mapping(book["dishes"], "dishes").items():
        if not isinstance(versions, list) or not versions:
            raise ValueError(f"{dish}: expected at least one revision")
        times = []
        for version in versions:
            mapping(version, dish)
            times.append(integer(version["from_ms"], 0, f"{dish}.from_ms"))
            if not quantities(version["uses"], components, 1, dish):
                raise ValueError(f"{dish}: empty recipe")
        if times != sorted(set(times)):
            raise ValueError(f"{dish}: revisions must have unique ascending start times")
        revisions[dish] = times
    return components, order, revisions


def plan(orders, book, stock, include_preparing=False):
    components, order, revisions = catalog(book)
    quantities(stock, components, 0, "stock")
    demand, portions = Counter(), Counter()
    selected, seen = [], set()
    for receipt in orders:
        mapping(receipt, "order")
        order_id = integer(receipt["id"], 1, "order ID")
        if order_id in seen:
            raise ValueError(f"Repeated order ID {order_id} in snapshot")
        seen.add(order_id)
        status = receipt["status"]
        if status not in ("pending", "preparing", "ready", "completed", "cancelled"):
            raise ValueError(f"Unknown order status {status}")
        if status != "pending" and not (include_preparing and status == "preparing"):
            continue
        at = integer(receipt["created"], 0, "order creation timestamp")
        selected.append(order_id)
        if not isinstance(receipt["items"], list) or not receipt["items"]:
            raise ValueError(f"Order {order_id} has no item list")
        for line in receipt["items"]:
            mapping(line, "item")
            dish, qty = line["id"], integer(line["qty"], 1, "portions")
            position = bisect_right(revisions.get(dish, []), at) - 1
            if position < 0:
                raise ValueError(f"No recipe for {dish} at {at} (order {order_id})")
            recipe = book["dishes"][dish][position]
            portions[dish, recipe["from_ms"]] += qty
            for part, amount in recipe["uses"].items():
                demand[part] += amount * qty
    lines = []
    for key in order:
        if not demand[key]:
            continue
        item = components[key]
        inputs = item.get("inputs")
        size = item["yield"] if inputs else item["pack"]
        available = stock.get(key, 0)
        short = max(0, demand[key] - available)
        batches = (short + size - 1) // size
        for part, amount in (inputs or {}).items():
            demand[part] += amount * batches
        lines.append({"component": key, "name": item.get("name", key), "unit": item["unit"],
                      "action": "prepare" if inputs else "purchase", "needed": demand[key],
                      "available": available, "batch_size": size, "batches": batches,
                      "remaining": available + batches * size - demand[key]})
    return {"included_orders": sorted(selected),
            "portions": [{"dish": dish, "from_ms": at, "quantity": qty} for (dish, at), qty in sorted(portions.items())],
            "lines": lines}


def snapshot(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        for order_id, created, status, items in db.execute("SELECT id,created,status,items FROM orders ORDER BY id"):
            yield {"id": order_id, "created": created, "status": status, "items": json.loads(items)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--orders", type=Path, help="JSON array returned by the kitchen API")
    source.add_argument("--database", type=Path, help="Read-only SQLite order database")
    parser.add_argument("--recipes", type=Path, required=True)
    parser.add_argument("--stock", type=Path, required=True)
    parser.add_argument("--include-preparing", action="store_true")
    args = parser.parse_args()
    def read(path):
        return json.loads(path.read_text(encoding="utf-8"))
    try:
        orders = read(args.orders) if args.orders else snapshot(args.database)
        result = plan(orders, read(args.recipes), read(args.stock), args.include_preparing)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, sqlite3.Error, TypeError, ValueError, KeyError) as error:
        parser.exit(2, f"{error}\n")
