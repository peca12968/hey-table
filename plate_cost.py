"""Estimate the ingredients consumed by the original portions on one Hey Table receipt."""

import argparse
from collections import Counter
from contextlib import closing
import csv
from fractions import Fraction
from graphlib import TopologicalSorter
import json
from pathlib import Path
import re
import sqlite3


def integer(value, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"expected an integer >= {minimum}")
    return value


def identifier(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing identifier or unit")
    return value


def mapping(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label}: expected an object")
    return value


def lot_key(dish, lot):
    bundle = lot["bundle"]
    return (
        identifier(dish),
        None if bundle is None else identifier(bundle),
        integer(lot["unit"]),
    )


def receipt(path, number):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("BEGIN")
        row = db.execute(
            "SELECT created,total,lots FROM receipts WHERE id=?", (number,)
        ).fetchone()
        if row is None:
            raise ValueError(f"unknown receipt {number}")
        created, total, data = row
        portions, sales, credits, remaining = Counter(), Counter(), Counter(), Counter()
        lots = json.loads(data)
        if not isinstance(lots, dict) or not lots:
            raise ValueError("empty or invalid receipt")
        for dish, lines in lots.items():
            if not isinstance(lines, list) or not lines:
                raise ValueError("empty or invalid price lots")
            for lot in lines:
                key = lot_key(dish, lot)
                qty = integer(lot["qty"], 1)
                remaining[key] += qty
                portions[dish] += qty
                sales[dish] += key[2] * qty
        if sum(sales.values()) != integer(total):
            raise ValueError("price lots do not add to receipt total")
        has_voids = db.execute(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='voids'"
        ).fetchone()
        query = "SELECT e.result FROM entries e WHERE e.receipt=?"
        if has_voids:
            query += " AND NOT EXISTS (SELECT 1 FROM voids v WHERE v.receipt=e.receipt AND v.request=e.request)"
        for (raw,) in db.execute(query, (number,)):
            entry = json.loads(raw)
            amount = 0
            for line in entry["lines"]:
                key = lot_key(line["dish"], line)
                qty = integer(line["qty"], 1)
                subtotal = qty * key[2]
                if remaining[key] < qty or integer(line["amount"]) != subtotal:
                    raise ValueError("return differs from the original price lots")
                remaining[key] -= qty
                credits[key[0]] += subtotal
                amount += subtotal
            if entry["receipt"] != number or amount != integer(entry["amount"]):
                raise ValueError("invalid return entry total or receipt")
        return integer(created), portions, sales, credits


def ingredients(book):
    components = mapping(book["components"], "components")
    graph = TopologicalSorter()
    for part, spec in components.items():
        identifier(part)
        identifier(mapping(spec, part)["unit"])
        if "inputs" in spec:
            if "pack" in spec or not spec["inputs"]:
                raise ValueError(f"{part}: invalid prepared component")
            integer(spec["yield"], 1)
        else:
            if "yield" in spec:
                raise ValueError(f"{part}: missing batch inputs")
            integer(spec["pack"], 1)
        graph.add(part)
        for child, units in mapping(spec.get("inputs", {}), part).items():
            if child not in components:
                raise ValueError(f"{part}: unknown ingredient {child}")
            integer(units, 1)
            graph.add(part, child)
    return list(reversed(tuple(graph.static_order())))


def raw_quantities(book, order, dish, created, portions):
    versions = mapping(book["dishes"], "dishes").get(dish, [])
    times = [integer(v["from_ms"]) for v in versions]
    if times != sorted(set(times)):
        raise ValueError(f"{dish}: duplicate or unordered recipe dates")
    chosen = next((v for v in reversed(versions) if v["from_ms"] <= created), None)
    if chosen is None or not chosen["uses"]:
        raise ValueError(f"{dish}: no applicable recipe")
    demand = Counter()
    for part, amount in mapping(chosen["uses"], dish).items():
        if part not in book["components"]:
            raise ValueError(f"{dish}: unknown component {part}")
        demand[part] = Fraction(integer(amount, 1) * portions)
    raw = {}
    for part in order:
        if part not in demand:
            continue
        spec = book["components"][part]
        if "inputs" not in spec:
            raw[part] = demand[part]
            continue
        batches = demand[part] / spec["yield"]
        for child, amount in spec["inputs"].items():
            demand[child] += batches * amount
    return chosen["from_ms"], raw


def prices_at(path, components, at):
    rates, dates = {}, set()
    with path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.reader(file, strict=True)
        if next(reader, None) != [
            "component",
            "unit",
            "from_ms",
            "pack_quantity",
            "pack_price_twd",
        ]:
            raise ValueError("unexpected price CSV columns")
        for part, unit, effective, size, price in reader:
            if (
                part not in components
                or "inputs" in components[part]
                or unit != components[part]["unit"]
            ):
                raise ValueError(
                    f"{part}: price must match a raw ingredient and its unit"
                )
            if not all(
                re.fullmatch(r"0|[1-9][0-9]*", field)
                for field in (effective, size, price)
            ):
                raise ValueError(f"{part}: invalid price, pack size or date")
            effective, size, price = int(effective), integer(int(size), 1), int(price)
            if (part, effective) in dates:
                raise ValueError(f"{part}: duplicate price effective date")
            dates.add((part, effective))
            if effective <= at and (part not in rates or effective > rates[part][0]):
                rates[part] = effective, Fraction(price, size)
    return rates


def cost_cents(exact):
    amounts = {dish: value * 100 for dish, value in exact.items()}
    cents = {dish: int(value) for dish, value in amounts.items()}
    target = int(sum(amounts.values()) + Fraction(1, 2))
    ranked = sorted(cents, key=lambda d: (-(amounts[d] - cents[d]), d))
    for dish in ranked[: target - sum(cents.values())]:
        cents[dish] += 1
    return cents


def report(db, number, book, price_file, price_at=None):
    created, portions, sales, credits = receipt(db, integer(number, 1))
    at = created if price_at is None else integer(price_at)
    components = book["components"]
    order = ingredients(book)
    rates = prices_at(price_file, components, at)
    lines, exact = [], {}
    for dish, qty in sorted(portions.items()):
        version, raw = raw_quantities(book, order, dish, created, qty)
        breakdown = []
        exact[dish] = Fraction(0)
        for part, units in sorted(raw.items()):
            if part not in rates:
                raise ValueError(f"{dish}: missing price for {part} at {at}")
            effective, price = rates[part]
            cost = units * price
            exact[dish] += cost
            breakdown.append(
                {
                    "component": part,
                    "unit": components[part]["unit"],
                    "quantity": str(units),
                    "price_from_ms": effective,
                    "twd_per_unit": str(price),
                    "cost_twd": str(cost),
                }
            )
        net = sales[dish] - credits[dish]
        lines.append(
            {
                "dish": dish,
                "portions": qty,
                "recipe_from_ms": version,
                "receipt_twd": sales[dish],
                "return_credit_twd": credits[dish],
                "net_twd": net,
                "ingredients": breakdown,
            }
        )
    cents = cost_cents(exact)
    for line in lines:
        cost = cents[line["dish"]]
        line.update(
            ingredient_cost_cents=cost,
            after_ingredients_cents=line["net_twd"] * 100 - cost,
        )
    fields = (
        "receipt_twd",
        "return_credit_twd",
        "net_twd",
        "ingredient_cost_cents",
        "after_ingredients_cents",
    )
    return {
        "receipt": number,
        "created_ms": created,
        "prices_at_ms": at,
        "currency": "TWD",
        "dishes": lines,
        "total": {field: sum(line[field] for line in lines) for field in fields},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("receipt", type=int)
    parser.add_argument("--recipes", type=Path, required=True)
    parser.add_argument("--prices", type=Path, required=True)
    parser.add_argument(
        "--price-at-ms",
        type=int,
        help="change ingredient prices while holding the original recipe fixed",
    )
    args = parser.parse_args()
    try:
        book = json.loads(args.recipes.read_bytes())
        result = report(
            args.database, args.receipt, book, args.prices, args.price_at_ms
        )
    except (
        OSError,
        ValueError,
        TypeError,
        KeyError,
        sqlite3.Error,
        csv.Error,
    ) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
