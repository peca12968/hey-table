"""Verify inspected returns against outbound box labels before posting a Stockroom batch."""

import argparse
import csv
from http.client import HTTPException
from io import StringIO
import json
from pathlib import Path
import re
import sys

from dispatch import indexed, integer, key
from execute import stockroom_client
from load_scan import SCAN
from replan import packing_snapshot


MAX_FILE = 65536
MAX_QUANTITY = 1_000_000
QUANTITY = re.compile(r"[1-9][0-9]{0,6}")


def parse_returns(document):
    if len(document.encode("utf-8")) > MAX_FILE:
        raise ValueError("inspection CSV exceeds 64 KiB")
    reader = csv.reader(StringIO(document, newline=""), strict=True)
    if next(reader, None) != ["code", "quantity"]:
        raise ValueError("expected CSV header code,quantity")
    entries = []
    seen = set()
    for row in reader:
        if not row:
            continue
        line = reader.line_num
        if len(row) != 2:
            raise ValueError(f"line {line}: expected a box code and inspected quantity")
        code, quantity = (value.strip() for value in row)
        label = SCAN.fullmatch(code)
        if not label or int(label[3]) > MAX_QUANTITY:
            raise ValueError(f"line {line}: invalid Dispatch Window box code")
        if not QUANTITY.fullmatch(quantity) or int(quantity) > MAX_QUANTITY:
            raise ValueError(f"line {line}: inspected quantity must be between 1 and {MAX_QUANTITY}")
        reservation, shipment = label[1], label[2]
        pair = (reservation, shipment)
        if pair in seen:
            raise ValueError(f"line {line}: {reservation}/{shipment} was already scanned")
        seen.add(pair)
        entries.append({"line": line, "code": code, "reservation_id": reservation, "shipment_id": shipment,
                        "label_quantity": int(label[3]), "quantity": int(quantity)})
        if len(entries) > 100:
            raise ValueError("Stockroom accepts at most 100 boxes per return batch")
    if not entries:
        raise ValueError("inspection CSV must contain at least one box")
    return entries


def inspection_rows(entries, snapshot):
    holds = indexed([{"id": row["reservation"]["id"], "boxes": row["boxes"]} for row in snapshot["holds"]], "id")
    if holds.keys() != {row["reservation_id"] for row in entries}:
        raise ValueError("packing snapshot does not cover the inspected reservations")
    shipped = {reservation: indexed(row["boxes"], "shipment_id") for reservation, row in holds.items()}
    rows = []
    for entry in entries:
        reservation, shipment = entry["reservation_id"], entry["shipment_id"]
        box = shipped[reservation].get(shipment)
        if box is None:
            rows.append({**entry, "dispatched": None, "returnable": None, "status": "unknown_shipment"})
            continue
        if box["reservation_id"] != reservation:
            raise ValueError("snapshot box belongs to another reservation")
        dispatched = integer(box["dispatched"], "dispatched", 1, MAX_QUANTITY)
        restocked = integer(box["restocked"], "restocked", high=dispatched)
        returnable = dispatched - restocked
        if integer(box["returnable"], "returnable") != returnable:
            raise ValueError("packing snapshot has inconsistent returnable units")
        if entry["label_quantity"] != dispatched:
            status = "label_mismatch"
        elif entry["quantity"] > returnable:
            status = "insufficient_returnable"
        else:
            status = "ready"
        rows.append({**entry, "dispatched": dispatched, "returnable": returnable, "status": status})
    return rows


def verify_receipt(batch_id, receipt, rows):
    expected = {(row["reservation_id"], row["shipment_id"]): row for row in rows}
    if receipt["batch_id"] != batch_id or len(receipt["boxes"]) != len(expected):
        raise ValueError("Stockroom receipt does not match the inspection batch")
    boxes = []
    for box in receipt["boxes"]:
        pair = (box["reservation_id"], box["shipment_id"])
        row = expected.pop(pair, None)
        if row is None or box["return_id"] != batch_id or integer(box["quantity"], "quantity", 1) != row["quantity"]:
            raise ValueError("batch ID is already used for different inspected boxes or quantities")
        remaining = integer(box["returnable_after"], "returnable_after", high=row["dispatched"] - row["quantity"])
        boxes.append({"reservation_id": pair[0], "shipment_id": pair[1], "return_id": batch_id,
                      "quantity": row["quantity"], "returnable_after": remaining})
    return {"batch_id": batch_id, "boxes": sorted(boxes, key=lambda box: (box["reservation_id"], box["shipment_id"]))}


def receive(document, batch_id, request, *, confirm=False):
    batch_id = key(batch_id)
    entries = parse_returns(document)
    snapshot = packing_snapshot(request, {entry["reservation_id"] for entry in entries})
    rows = inspection_rows(entries, snapshot)
    result = {"format": "dispatch-window.return-inspection.v1", "batch_id": batch_id,
              "captured_at_ms": integer(snapshot["captured_at_ms"], "captured_at_ms"), "boxes": rows}
    if any(row["status"] in ("unknown_shipment", "label_mismatch") for row in rows):
        return {**result, "state": "blocked"}

    status, saved = request("/return-batches/" + batch_id)
    if status == 200:
        return {**result, "state": "recovered", "receipt": verify_receipt(batch_id, saved, rows)}
    if status != 404:
        return {**result, "state": "retry", "http_status": status}
    if any(row["status"] != "ready" for row in rows):
        return {**result, "state": "blocked"}
    if not confirm:
        return {**result, "state": "ready"}

    boxes = [{field: row[field] for field in ("reservation_id", "shipment_id", "quantity")} for row in rows]
    try:
        status, saved = request("/return-batches", {"boxes": boxes}, {"Idempotency-Key": batch_id})
        if status in (200, 201):
            return {**result, "state": "received" if status == 201 else "recovered",
                    "receipt": verify_receipt(batch_id, saved, rows)}
        return {**result, "state": "conflict" if status in (404, 409, 422) else "retry", "http_status": status}
    except (OSError, HTTPException, ValueError, TypeError, KeyError):
        return {**result, "state": "retry"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inspection", type=Path, help="UTF-8 CSV with the columns code,quantity")
    parser.add_argument("--batch-id", required=True, help="Stable receiving batch ID, reused for retries")
    parser.add_argument("--stockroom", required=True, help="Stockroom HTTP(S) base URL")
    parser.add_argument("--confirm", action="store_true", help="Post verified boxes as a single return batch")
    args = parser.parse_args(argv)
    try:
        with args.inspection.open("rb") as handle:
            contents = handle.read(MAX_FILE + 1)
        if len(contents) > MAX_FILE:
            raise ValueError("inspection CSV exceeds 64 KiB")
        result = receive(contents.decode("utf-8-sig"), args.batch_id, stockroom_client(args.stockroom), confirm=args.confirm)
    except (OSError, HTTPException, ValueError, TypeError, KeyError, csv.Error) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))
    return int(result["state"] in ("conflict", "retry", "blocked"))


if __name__ == "__main__":
    sys.exit(main())
