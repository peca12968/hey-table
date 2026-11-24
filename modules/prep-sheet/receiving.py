"""Import a Pantry Freight purchase order and receive supplier shipments by pack."""
import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from ledger import connect, prior_receipt, read_inventory, read_json, record_movement
from prep import catalog, integer, mapping


def identifier(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing {label}")
    return value


def ordered_lines(report, components):
    if mapping(report, "report").get("status") != "ok" or not report.get("orders"):
        raise ValueError("Expected a feasible, nonempty Pantry Freight order")
    lines = {}
    for vendor in report["orders"]:
        supplier = identifier(vendor["supplier"], "supplier")
        if not vendor["lines"]:
            raise ValueError(f"{supplier}: missing order lines")
        for line in vendor["lines"]:
            sku = identifier(line["sku"], "SKU")
            key = (supplier, sku)
            component = line["component"]
            if key in lines:
                raise ValueError(f"{supplier}/{sku}: duplicate line")
            if component not in components or "pack" not in components[component]:
                raise ValueError(f"{component}: unknown raw ingredient")
            unit = components[component]["unit"]
            if line["unit"] != unit:
                raise ValueError(f"{component}: order and recipe units differ")
            size = integer(line["pack"], 1, "pack size")
            count = integer(line["packs"], 1, "ordered packs")
            if size * count > 2**63 - 1:
                raise ValueError(f"{sku}: quantity exceeds SQLite integer range")
            lines[key] = (component, unit, size, count)
    return lines


def status(db, order_id):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_lines'").fetchone():
        raise ValueError(f"Unknown purchase order {order_id}")
    items = []
    for supplier, sku, component, unit, size, ordered, received in db.execute(
            """SELECT supplier,sku,component,unit,pack_size,ordered,received FROM purchase_lines
               WHERE po=? ORDER BY supplier,sku""", (order_id,)):
        items.append({"supplier": supplier, "sku": sku, "component": component, "unit": unit,
                      "pack": size, "ordered_packs": ordered, "received_packs": received,
                      "remaining_packs": ordered - received})
    if not items:
        raise ValueError(f"Unknown purchase order {order_id}")
    remaining = sum(line["remaining_packs"] for line in items)
    state = "open"
    if remaining == 0:
        state = "received"
    elif any(line["received_packs"] for line in items):
        state = "partial"
    return {"purchase_order": order_id, "state": state, "remaining_packs": remaining, "lines": items}


def procurement_snapshot(path, book, order_ids):
    incoming = Counter()
    with closing(connect(path, "ro")) as db:
        db.execute("BEGIN")
        stock, issued = read_inventory(db, book)
        for order_id in dict.fromkeys(order_ids):
            for line in status(db, order_id)["lines"]:
                if not line["remaining_packs"]:
                    continue
                component = line["component"]
                recipe = book["components"].get(component, {})
                if recipe.get("unit") != line["unit"] or "pack" not in recipe:
                    raise ValueError(f"{order_id}/{component}: purchase order and recipe no longer match")
                incoming[component] += line["remaining_packs"] * line["pack"]
    return stock, issued, dict(incoming)


def open_order(path, book, order_id, report):
    identifier(order_id, "purchase order ID")
    components, _, _ = catalog(book)
    lines = ordered_lines(report, components)
    with closing(connect(path, "rw")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        # The original ledger schema remains usable by older kitchen clients.
        db.execute("SELECT id FROM receipts LIMIT 0")
        db.execute("""CREATE TABLE IF NOT EXISTS purchase_lines (
            po TEXT NOT NULL, supplier TEXT NOT NULL, sku TEXT NOT NULL,
            component TEXT NOT NULL, unit TEXT NOT NULL, pack_size INTEGER NOT NULL CHECK(pack_size>0),
            ordered INTEGER NOT NULL CHECK(ordered>0),
            received INTEGER NOT NULL DEFAULT 0 CHECK(received BETWEEN 0 AND ordered),
            PRIMARY KEY(po,supplier,sku))""")
        existing = {(s, sku): (c, u, size, n) for s, sku, c, u, size, n in db.execute(
            "SELECT supplier,sku,component,unit,pack_size,ordered FROM purchase_lines WHERE po=?", (order_id,))}
        if existing and existing != lines:
            raise ValueError(f"{order_id}: purchase order already has different lines")
        if not existing:
            db.executemany("""INSERT INTO purchase_lines(po,supplier,sku,component,unit,pack_size,ordered)
                              VALUES(?,?,?,?,?,?,?)""",
                           [(order_id, *key, *values) for key, values in lines.items()])
        return status(db, order_id)


def accept(path, book, order_id, supplier, slip, packs):
    components, _, _ = catalog(book)
    reference = json.dumps([identifier(value, label) for value, label in
                            [(order_id, "purchase order ID"), (supplier, "supplier"), (slip, "delivery ID")]],
                           ensure_ascii=False)
    if not mapping(packs, "received packs"):
        raise ValueError("An empty delivery cannot be posted")
    for sku, count in packs.items():
        integer(count, 1, sku)
    request = json.dumps(packs, sort_keys=True)
    with closing(connect(path, "rw")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        previous = prior_receipt(db, "purchase_receive", reference, request)
        if previous:
            return previous
        lines = {line["sku"]: line for line in status(db, order_id)["lines"] if line["supplier"] == supplier}
        changes = Counter()
        for sku, count in packs.items():
            if sku not in lines:
                raise ValueError(f"{supplier}/{sku}: SKU is absent from this purchase order")
            line = lines[sku]
            if count > line["remaining_packs"]:
                raise ValueError(f"{sku}: only {line['remaining_packs']} packs outstanding")
            component = line["component"]
            recipe = components.get(component, {})
            if recipe.get("unit") != line["unit"] or "pack" not in recipe:
                raise ValueError(f"{component}: purchase order and recipe no longer match")
            changes[component] += count * line["pack"]
            db.execute("UPDATE purchase_lines SET received=received+? WHERE po=? AND supplier=? AND sku=?",
                       (count, order_id, supplier, sku))
        return record_movement(db, components, "purchase_receive", reference, request, changes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--recipes", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    opening = commands.add_parser("open")
    opening.add_argument("order_id")
    opening.add_argument("report", type=Path)
    delivery = commands.add_parser("accept")
    delivery.add_argument("order_id")
    delivery.add_argument("supplier")
    delivery.add_argument("slip")
    delivery.add_argument("packs", type=Path)
    commands.add_parser("status").add_argument("order_id")
    args = parser.parse_args()
    try:
        if args.command == "status":
            with closing(connect(args.db, "ro")) as db:
                db.execute("BEGIN")
                result = status(db, args.order_id)
        else:
            if not args.recipes:
                parser.error("open and accept require --recipes")
            book = read_json(args.recipes)
            if args.command == "open":
                result = open_order(args.db, book, args.order_id, read_json(args.report))
            else:
                result = accept(args.db, book, args.order_id, args.supplier, args.slip, read_json(args.packs))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, sqlite3.Error, KeyError, TypeError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
