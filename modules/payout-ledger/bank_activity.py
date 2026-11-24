"""Reconcile one Taipei day of TapPay capture and refund activity with Hey Table."""

import argparse
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.error import URLError
from urllib.request import Request, build_opener

from restaurant_close import COLUMNS, DAY_MS, NoRedirect, day_start, identifier, integer
from restaurant_source import add_restaurant_source, open_restaurant


ACTIONS = ("CAPTURE", "REFUND")


@dataclass(frozen=True)
class Activity:
    merchant: str
    trade_id: str
    reference: str
    method: str
    currency: str
    action: str
    successful: bool
    bank_ms: int
    trigger_ms: int
    amount: int
    authorized: int
    refund_reference: str | None


def activity(raw, scope):
    if not isinstance(raw, dict):
        raise ValueError("expected an activity row")
    at = integer(raw.get("bank_transaction_millis"), "bank_transaction_millis")
    merchant, action = raw.get("merchant_id"), raw.get("transaction_action")
    if (
        merchant not in scope["merchant_ids"]
        or action not in ACTIONS
        or not scope["start_time_millis"] <= at <= scope["end_time_millis"]
    ):
        raise ValueError("bank activity is outside requested scope")
    success = raw.get("transaction_result")
    amount = integer(raw.get("trade_amount"), "trade_amount")
    if type(success) is not bool or (success and amount == 0):
        raise ValueError("invalid activity result or trade_amount")
    refund_ref = raw.get("bank_refund_order_number")
    if refund_ref not in (None, ""):
        refund_ref = identifier(refund_ref, "bank_refund_order_number")
    return Activity(
        merchant,
        identifier(raw.get("rec_trade_id"), "rec_trade_id"),
        identifier(raw.get("bank_transaction_id"), "bank_transaction_id"),
        identifier(raw.get("payment_method"), "payment_method"),
        identifier(raw.get("currency"), "currency"),
        action,
        success,
        at,
        integer(raw.get("millis"), "millis"),
        amount,
        integer(raw.get("auth_amount"), "auth_amount"),
        refund_ref or None,
    )


def read_snapshot(path, scope):
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(document, dict) or document.get("scope") != scope:
        raise ValueError(
            "snapshot scope must match environment, merchants, date and actions"
        )
    return read_pages(document.get("pages"), scope)


def fetch_pages(scope, key):
    host = {"sandbox": "sandbox", "production": "prod"}[scope["environment"]]
    opener = build_opener(NoRedirect())
    params = {field: value for field, value in scope.items() if field != "environment"}
    pages = []
    total = 1
    while len(pages) < total:
        request = Request(
            f"https://{host}.tappaysdk.com/tpc/transaction/reconciliation",
            data=json.dumps(
                dict(params, partner_key=key, records_per_page=200, page=len(pages))
            ).encode(),
            headers={"Content-Type": "application/json", "x-api-key": key},
        )
        with opener.open(request, timeout=30) as response:
            page = json.load(response)
        if (
            not isinstance(page, dict)
            or type(page.get("status")) is not int
            or page["status"] not in (0, 2)
        ):
            raise ValueError("Reconciliation API did not return a successful page")
        total_pages = integer(page.get("total_page_count"), "total_page_count")
        if not pages:
            total = max(1, total_pages)
        elif total != total_pages:
            raise ValueError("Reconciliation API pages changed while fetching")
        if integer(page.get("page"), "page") != len(pages):
            raise ValueError("Reconciliation API returned an unexpected page")
        pages.append(page)
    return pages


def read_pages(pages, scope):
    if not isinstance(pages, list) or not pages:
        raise ValueError("expected at least one Reconciliation API page")
    totals, records = None, []
    seen, refund_refs = set(), set()
    for index, page in enumerate(pages):
        if (
            not isinstance(page, dict)
            or type(page.get("status")) is not int
            or page["status"] not in (0, 2)
        ):
            raise ValueError("Reconciliation API did not return a successful page")
        count = integer(page.get("number_of_transactions"), "number_of_transactions")
        num_pages = integer(page.get("total_page_count"), "total_page_count")
        rows = page.get("reconciliation_datas")
        if (
            integer(page.get("page"), "page") != index
            or len(pages) != max(1, num_pages)
            or (count and not num_pages)
            or not isinstance(rows, list)
            or (totals is not None and totals != (count, num_pages))
        ):
            raise ValueError("incomplete snapshot or inconsistent pages")
        totals = (count, num_pages)
        for raw in rows:
            row = activity(raw, scope)
            if row in seen:
                raise ValueError(
                    f"{row.trade_id}: repeated or indistinguishable bank activity"
                )
            seen.add(row)
            if (
                row.action == "REFUND"
                and row.successful
                and row.refund_reference is not None
            ):
                key = row.merchant, row.trade_id, row.refund_reference
                if key in refund_refs:
                    raise ValueError(
                        f"{row.trade_id}: repeated successful bank refund number"
                    )
                refund_refs.add(key)
            records.append(row)
    if totals[0] != len(records):
        raise ValueError("snapshot row count does not match number_of_transactions")
    return sorted(
        records,
        key=lambda r: (
            r.bank_ms,
            r.merchant,
            r.trade_id,
            r.trigger_ms,
            r.action,
            r.refund_reference or "",
        ),
    )


def match(db, row, environment):
    candidates = db.execute(
        COLUMNS + " AND (a.reference=? OR a.trade_id=?)",
        (row.merchant, environment, row.reference, row.trade_id),
    ).fetchall()
    if not candidates:
        return None, ["no_local_transaction"]
    if len(candidates) != 1:
        return None, ["conflicting_local_identifiers"]
    (local,) = candidates
    method = (
        "direct_pay" if local["payment_method"] == "card" else local["payment_method"]
    )
    reasons = [
        label
        for label, actual, expected in [
            ("reference_mismatch", row.reference, local["reference"]),
            ("trade_id_mismatch", row.trade_id, local["trade_id"]),
            ("method_mismatch", row.method, method),
            ("authorization_amount_mismatch", row.authorized, local["total"]),
        ]
        if actual != expected
    ]
    if row.amount > local["total"]:
        reasons.append("activity_exceeds_order")
    return (None if reasons else local), reasons


def reconcile(db, scope, records):
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")
    start = scope["start_time_millis"]
    groups, events, issues = {}, [], []
    excluded = defaultdict(int)
    matches = {}
    for row in records:
        if row.currency != "TWD":
            excluded[row.currency] += 1
            continue
        key = (
            row.merchant,
            row.trade_id,
            row.reference,
            row.method,
            row.authorized,
            row.amount,
        )
        if key not in matches:
            matches[key] = match(db, row, scope["environment"])
        local, reasons = matches[key]
        earlier = local is not None and local["created"] < start
        event = asdict(row) | {
            "order_id": None if local is None else local["order_id"],
            "earlier_attempt": earlier,
        }
        if not row.successful:
            reasons = [*reasons, "bank_action_failed"]
        if reasons:
            issues.append(event | {"reasons": reasons})
        events.append(event)
        figures = groups.setdefault(
            row.method,
            {
                "capture_twd": 0,
                "refund_twd": 0,
                "earlier_attempt_refund_twd": 0,
                "failed_actions": 0,
                "net_twd": 0,
            },
        )
        if row.successful:
            if row.action == "CAPTURE":
                figures["capture_twd"] += row.amount
                figures["net_twd"] += row.amount
            else:
                figures["refund_twd"] += row.amount
                figures["net_twd"] -= row.amount
                if earlier:
                    figures["earlier_attempt_refund_twd"] += row.amount
        else:
            figures["failed_actions"] += 1
    return {
        "by_method": groups,
        "net_twd": sum(g["net_twd"] for g in groups.values()),
        "events": events,
        "issues": issues,
        "excluded_by_currency": dict(excluded),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    add_restaurant_source(parser)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--snapshot",
        type=Path,
        help="offline Reconciliation API pages and their request scope",
    )
    source.add_argument(
        "--fetch", action="store_true", help="query TapPay with TAPPAY_PARTNER_KEY"
    )
    parser.add_argument("--day", required=True)
    parser.add_argument(
        "--environment", choices=["sandbox", "production"], required=True
    )
    parser.add_argument("--merchant", action="append", required=True)
    parser.add_argument(
        "--strict", action="store_true", help="exit 3 when any TWD event needs review"
    )
    args = parser.parse_args(argv)
    try:
        if date.fromisoformat(args.day).isoformat() != args.day:
            raise ValueError("expected YYYY-MM-DD")
        start = day_start(args.day)
        scope = {
            "environment": args.environment,
            "merchant_ids": sorted({identifier(m, "merchant") for m in args.merchant}),
            "start_time_millis": start,
            "end_time_millis": start + DAY_MS - 1,
            "transaction_actions": list(ACTIONS),
        }
        with open_restaurant(args.database, args.restaurant_snapshot, args.environment) as db:
            db.execute("PRAGMA trusted_schema=OFF")
            if args.snapshot:
                records = read_snapshot(args.snapshot, scope)
            else:
                key = os.environ.get("TAPPAY_PARTNER_KEY")
                if not key:
                    raise ValueError("TAPPAY_PARTNER_KEY is required for --fetch")
                records = read_pages(fetch_pages(scope, key), scope)
            report = reconcile(db, scope, records)
        print(
            json.dumps(
                {"day": args.day, "scope": scope, **report}, sort_keys=True, indent=2
            )
        )
        return 3 if args.strict and report["issues"] else 0
    except (ValueError, OSError, URLError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
