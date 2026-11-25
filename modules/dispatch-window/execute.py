"""Look up and submit due Dispatch Window batches to Stockroom."""

import argparse
from hashlib import sha256
from http.client import HTTPException
import json
from pathlib import Path
import sys
from time import time_ns
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from dispatch import MAX_ORDERS, integer, key


def now_ms():
    return time_ns() // 1_000_000


def batch_boxes(rows, reservation, *, receipt=False):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ValueError("expected 1 to 100 boxes per dispatch batch")
    boxes = []
    seen = set()
    for row in rows:
        shipment = key(row["shipment_id"])
        if row["reservation_id"] != reservation or shipment in seen:
            raise ValueError("dispatch boxes must belong to the order and have distinct shipment IDs")
        seen.add(shipment)
        box = {"reservation_id": reservation, "shipment_id": shipment,
               "quantity": integer(row["quantity"], "quantity", 1, 1_000_000)}
        if receipt:
            box["held_after"] = integer(row["held_after"], "held_after")
        boxes.append(box)
    return sorted(boxes, key=lambda box: box["shipment_id"])


def prepare(report, selected):
    start = integer(report["start_ms"], "start_ms")
    cutoff = integer(report["cutoff_ms"], "cutoff_ms", start + 1)
    scheduled = report["scheduled"]
    if not isinstance(scheduled, list) or len(scheduled) > MAX_ORDERS:
        raise ValueError(f"expected up to {MAX_ORDERS} scheduled orders")
    jobs = {}
    for row in scheduled:
        reservation = key(row["reservation_id"])
        if reservation in jobs:
            raise ValueError(f"{reservation}: duplicate scheduled order")
        packing = integer(row["pack_start_ms"], "pack_start_ms", start)
        deadline = integer(row["deadline_ms"], "deadline_ms", packing + 2, cutoff)
        dispatch = integer(row["dispatch_ms"], "dispatch_ms", packing + 1, deadline - 1)
        boxes = batch_boxes(row["dispatch"]["boxes"], reservation)
        units = sum(box["quantity"] for box in boxes)
        if integer(row["units"], "units", 1) != units:
            raise ValueError(f"{reservation}: the planned units do not match its boxes")
        digest = sha256(json.dumps(boxes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        jobs[reservation] = {
            "reservation_id": reservation, "batch_id": "dispatch-" + digest, "units": units,
            "boxes": boxes, "window": {"not_before_ms": dispatch, "before_ms": deadline},
        }
    if integer(report["ship_units"], "ship_units") != sum(job["units"] for job in jobs.values()):
        raise ValueError("planned shipment total does not match the scheduled orders")
    unknown = set(selected) - jobs.keys()
    if unknown:
        raise ValueError("orders absent from the plan: " + ", ".join(sorted(unknown)))
    return sorted((job for reservation, job in jobs.items() if not selected or reservation in selected),
                  key=lambda job: (job["window"]["not_before_ms"], job["reservation_id"]))


def verify_receipt(body, job):
    if body["batch_id"] != job["batch_id"]:
        raise ValueError("unexpected dispatch batch receipt ID")
    boxes = batch_boxes(body["boxes"], job["reservation_id"], receipt=True)
    if [{key: value for key, value in box.items() if key != "held_after"} for box in boxes] != job["boxes"]:
        raise ValueError("dispatch receipt does not match the order")
    return {"batch_id": job["batch_id"], "boxes": boxes}


def execute_job(job, request, clock):
    window = job["window"]
    try:
        if request is not None:
            status, body = request("/dispatch-batches/" + job["batch_id"])
            if status == 200:
                return {"state": "recovered", "receipt": verify_receipt(body, job)}
            if status != 404:
                return {"state": "retry", "http_status": status}
        now = clock()
        if now < window["not_before_ms"]:
            return {"state": "waiting"}
        if now >= window["before_ms"]:
            return {"state": "expired"}
        if request is None:
            return {"state": "due"}
        status, body = request("/dispatch-batches", {"boxes": job["boxes"], "window": window},
                               {"Idempotency-Key": job["batch_id"]})
        if status in (200, 201):
            return {"state": "dispatched" if status == 201 else "recovered", "receipt": verify_receipt(body, job)}
        return {"state": "rejected" if status in (404, 409, 422) else "retry", "http_status": status}
    except (OSError, HTTPException, ValueError, TypeError, KeyError):
        return {"state": "retry"}


def execute(report, request=None, *, clock=now_ms, selected=()):
    jobs = prepare(report, selected)
    captured = clock()
    results = []
    for job in jobs:
        result = {field: job[field] for field in ("reservation_id", "batch_id", "units", "window")}
        result.update(execute_job(job, request, clock))
        results.append(result)
    return {"captured_at_ms": captured, "confirmed_units": sum(row["units"] for row in results if "receipt" in row),
            "results": results}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def stockroom_client(base):
    parsed = urlsplit(base)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None
            or parsed.query or parsed.fragment):
        raise ValueError("Stockroom must be an HTTP(S) base URL without credentials, query, or fragment")
    opener = build_opener(NoRedirect())

    def request(path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        fields = {"Accept": "application/json", **(headers or {})}
        if data is not None:
            fields["Content-Type"] = "application/json"
        query = Request(base.rstrip("/") + path, data=data, headers=fields)
        try:
            with opener.open(query, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, None

    return request


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--stockroom", help="Stockroom HTTP(S) base URL")
    parser.add_argument("--confirm", action="store_true", help="Send due boxes after confirming they are packed")
    parser.add_argument("--reservation", action="append", default=[], help="Select an order, repeat for multiple orders")
    args = parser.parse_args(argv)
    if args.confirm and not args.stockroom:
        parser.error("--confirm requires --stockroom")
    try:
        report = json.loads(args.plan.read_text(encoding="utf-8-sig"))
        client = stockroom_client(args.stockroom) if args.confirm else None
        result = execute(report, client, selected=args.reservation)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))
    return int(any(row["state"] in ("retry", "rejected", "expired") for row in result["results"]))


if __name__ == "__main__":
    sys.exit(main())
