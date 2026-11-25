"""Open Pantry Freight orders and record deliveries or supplier cancellations by pack."""
import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from ledger import connect, prior_receipt, read_inventory, read_json, record_movement
from prep import catalog, integer, mapping

DELIVERY_DRAFT = "prep-sheet.receiving-draft.v1"


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
    tables = {name for (name,) in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('purchase_lines','purchase_cancellations')")}
    if "purchase_lines" not in tables:
        raise ValueError(f"Unknown purchase order {order_id}")
    cancellations = []
    cancelled_by_line = Counter()
    if "purchase_cancellations" in tables:
        for supplier, reference, request, cancelled_at in db.execute(
                """SELECT supplier,reference,packs,cancelled_at FROM purchase_cancellations
                   WHERE po=? ORDER BY id""", (order_id,)):
            packs = json.loads(request)
            cancellations.append({"supplier": supplier, "reference": reference,
                                  "packs": packs, "cancelled_at": cancelled_at})
            for sku, count in packs.items():
                cancelled_by_line[supplier, sku] += count
    items = []
    for supplier, sku, component, unit, size, ordered, received in db.execute(
            """SELECT supplier,sku,component,unit,pack_size,ordered,received FROM purchase_lines
               WHERE po=? ORDER BY supplier,sku""", (order_id,)):
        cancelled = cancelled_by_line[supplier, sku]
        items.append({"supplier": supplier, "sku": sku, "component": component, "unit": unit,
                      "pack": size, "ordered_packs": ordered, "received_packs": received,
                      "cancelled_packs": cancelled, "remaining_packs": ordered - received - cancelled})
    if not items:
        raise ValueError(f"Unknown purchase order {order_id}")
    remaining = sum(line["remaining_packs"] for line in items)
    received = sum(line["received_packs"] for line in items)
    if remaining == 0:
        if cancellations:
            state = "closed" if received else "cancelled"
        else:
            state = "received"
    elif received or cancellations:
        state = "partial"
    else:
        state = "open"
    return {"purchase_order": order_id, "state": state, "remaining_packs": remaining, "lines": items,
            "cancellations": cancellations}


def procurement_snapshot(path, book, order_ids):
    stock, issued, incoming, _ = procurement_with_orders(path, book, order_ids)
    return stock, issued, incoming


def procurement_with_orders(path, book, order_ids):
    incoming = Counter()
    incoming_orders = []
    fields = ("supplier", "sku", "component", "unit", "pack", "remaining_packs")
    with closing(connect(path, "ro")) as db:
        db.execute("BEGIN")
        stock, issued = read_inventory(db, book)
        for order_id in dict.fromkeys(order_ids):
            lines = []
            for line in status(db, order_id)["lines"]:
                if not line["remaining_packs"]:
                    continue
                component = line["component"]
                recipe = book["components"].get(component, {})
                if recipe.get("unit") != line["unit"] or "pack" not in recipe:
                    raise ValueError(f"{order_id}/{component}: purchase order and recipe no longer match")
                incoming[component] += line["remaining_packs"] * line["pack"]
                lines.append({field: line[field] for field in fields})
            incoming_orders.append({"purchase_order": order_id, "lines": lines})
    return stock, issued, dict(incoming), incoming_orders


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


def pack_request(packs):
    if not mapping(packs, "packs by SKU"):
        raise ValueError("At least one SKU is required")
    for sku, count in packs.items():
        integer(count, 1, sku)
    return json.dumps(packs, sort_keys=True)


def outstanding_lines(db, order_id, supplier, packs, expected=None):
    lines = {line["sku"]: line for line in status(db, order_id)["lines"] if line["supplier"] == supplier}
    for sku, count in packs.items():
        if sku not in lines:
            raise ValueError(f"{supplier}/{sku}: SKU is absent from this purchase order")
        line = lines[sku]
        if expected is not None and any(line[field] != value for field, value in expected[sku].items()):
            raise ValueError(f"{supplier}/{sku}: purchase order changed; export a fresh status before receiving")
        remaining = line["remaining_packs"]
        if count > remaining:
            raise ValueError(f"{sku}: only {remaining} packs outstanding")
    return lines


def accept(path, book, order_id, supplier, slip, packs, *, expected=None):
    components, _, _ = catalog(book)
    reference = json.dumps([identifier(value, label) for value, label in
                            [(order_id, "purchase order ID"), (supplier, "supplier"), (slip, "delivery ID")]],
                           ensure_ascii=False)
    request = pack_request(packs)
    with closing(connect(path, "rw")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        previous = prior_receipt(db, "purchase_receive", reference, request)
        if previous:
            return previous
        lines = outstanding_lines(db, order_id, supplier, packs, expected)
        changes = Counter()
        for sku, count in packs.items():
            line = lines[sku]
            component = line["component"]
            recipe = components.get(component, {})
            if recipe.get("unit") != line["unit"] or "pack" not in recipe:
                raise ValueError(f"{component}: purchase order and recipe no longer match")
            changes[component] += count * line["pack"]
            db.execute("UPDATE purchase_lines SET received=received+? WHERE po=? AND supplier=? AND sku=?",
                       (count, order_id, supplier, sku))
        return record_movement(db, components, "purchase_receive", reference, request, changes)


def accept_draft(path, book, draft):
    if mapping(draft, "delivery draft").get("format") != DELIVERY_DRAFT or not isinstance(draft.get("lines"), list):
        raise ValueError("Invalid delivery draft")
    packs, expected = {}, {}
    for line in draft["lines"]:
        row = mapping(line, "delivery line")
        sku = identifier(row["sku"], "SKU")
        if sku in packs:
            raise ValueError(f"{sku}: duplicate SKU in draft")
        before = {
            "component": identifier(row["component"], "component"),
            "unit": identifier(row["unit"], "unit"),
            "pack": integer(row["pack"], 1, "pack size"),
            "ordered_packs": integer(row["ordered_packs"], 1, "ordered packs"),
            "received_packs": integer(row["received_packs"], 0, "previously received packs"),
            "cancelled_packs": integer(row["cancelled_packs"], 0, "cancelled packs"),
            "remaining_packs": integer(row["remaining_packs"], 0, "previously outstanding packs"),
        }
        count = integer(row["packs"], 1, "delivered packs")
        if (before["ordered_packs"] - before["received_packs"] - before["cancelled_packs"]
                != before["remaining_packs"] or count > before["remaining_packs"]):
            raise ValueError(f"{sku}: draft quantities do not reconcile")
        packs[sku] = count
        expected[sku] = before
    return accept(path, book, draft["purchase_order"], draft["supplier"], draft["delivery_id"],
                  packs, expected=expected)


def cancel(path, order_id, supplier, reference, packs):
    identifier(order_id, "purchase order ID")
    identifier(supplier, "supplier")
    identifier(reference, "cancellation ID")
    request = pack_request(packs)
    key = (order_id, supplier, reference)
    with closing(connect(path, "rw")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""CREATE TABLE IF NOT EXISTS purchase_cancellations (
            id INTEGER PRIMARY KEY, po TEXT NOT NULL, supplier TEXT NOT NULL, reference TEXT NOT NULL,
            packs TEXT NOT NULL, cancelled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(po,supplier,reference))""")
        existing = db.execute("""SELECT packs,cancelled_at FROM purchase_cancellations
                                 WHERE po=? AND supplier=? AND reference=?""", key).fetchone()
        if existing:
            if existing[0] != request:
                raise ValueError(f"{reference}: cancellation reference already used with different quantities")
            cancelled_at = existing[1]
        else:
            outstanding_lines(db, order_id, supplier, packs)
            cancelled_at, = db.execute("""INSERT INTO purchase_cancellations(po,supplier,reference,packs)
                                          VALUES(?,?,?,?) RETURNING cancelled_at""", (*key, request)).fetchone()
        return {"purchase_order": order_id, "supplier": supplier, "reference": reference,
                "packs": packs, "cancelled_at": cancelled_at}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--recipes", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    opening = commands.add_parser("open")
    opening.add_argument("order_id")
    opening.add_argument("report", type=Path)
    commands.add_parser("accept-draft").add_argument("draft", type=Path)
    commands.add_parser("procurement").add_argument("--incoming", action="append", default=[], metavar="PURCHASE_ORDER")
    for name in ("accept", "cancel"):
        operation = commands.add_parser(name)
        operation.add_argument("order_id")
        operation.add_argument("supplier")
        operation.add_argument("reference")
        operation.add_argument("packs", type=Path)
    commands.add_parser("status").add_argument("order_id")
    args = parser.parse_args()
    try:
        if args.command == "status":
            with closing(connect(args.db, "ro")) as db:
                db.execute("BEGIN")
                result = status(db, args.order_id)
        elif args.command == "cancel":
            result = cancel(args.db, args.order_id, args.supplier, args.reference, read_json(args.packs))
        else:
            if not args.recipes:
                parser.error("open, accept, accept-draft and procurement require --recipes")
            book = read_json(args.recipes)
            if args.command == "open":
                result = open_order(args.db, book, args.order_id, read_json(args.report))
            elif args.command == "accept-draft":
                result = accept_draft(args.db, book, read_json(args.draft))
            elif args.command == "procurement":
                purchase_orders = list(dict.fromkeys(args.incoming))
                stock, issued, incoming, incoming_orders = procurement_with_orders(args.db, book, purchase_orders)
                result = {"format": "prep-sheet.procurement.v1", "stock": stock, "incoming": incoming,
                          "units": {component: book["components"][component]["unit"]
                                    for component in sorted(stock.keys() | incoming.keys())},
                          "purchase_orders": purchase_orders,
                          "incoming_orders": incoming_orders,
                          "issued": [{"id": key, **identity} for key, identity in sorted(issued.items())]}
            else:
                result = accept(args.db, book, args.order_id, args.supplier, args.reference, read_json(args.packs))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, sqlite3.Error, KeyError, TypeError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
