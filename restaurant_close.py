"""Compare Hey Table payment attempts with TapPay Record API transactions for a Taipei day."""
import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import date, datetime, time, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

STATES = {-1: "failed", 0: "authorized", 1: "paid", 2: "partial", 3: "refunded",
          4: "pending", 5: "cancelled"}
DAY_MS = 86_400_000
TAIPEI = timezone(timedelta(hours=8))
COLUMNS = """SELECT a.reference, a.trade_id, a.created, a.state, o.id AS order_id,
                    o.payment_method, o.total FROM payment_attempts a JOIN orders o ON o.id=a.order_id
             WHERE a.merchant=? AND o.payment_env=?"""
COUNTED = {"paid", "partial", "refunded"}


def day_start(day):
    return int(datetime.combine(date.fromisoformat(day), time(), TAIPEI).timestamp()) * 1000


def integer(value, field):
    if type(value) is not int or value < 0:
        raise ValueError(f"invalid {field}")
    return value


def identifier(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"missing {field}")
    return value


def transaction(raw, scope):
    if not isinstance(raw, dict) or raw.get("merchant_id") != scope["merchant"] or raw.get("currency", "TWD") != "TWD":
        raise ValueError("record is outside merchant or currency scope")
    at = integer(raw.get("time"), "time")
    if not scope["start_time"] <= at <= scope["end_time"]:
        raise ValueError("record is outside the requested time window")
    status = raw.get("record_status")
    if type(status) is not int or status not in STATES:
        raise ValueError("unknown record_status")
    amount = integer(raw.get("amount"), "amount")
    original = integer(raw.get("original_amount", amount), "original_amount")
    if status in (2, 3) and "original_amount" not in raw:
        raise ValueError("refund record lacks original_amount")
    if (status == 2 and not 0 < amount < original) or (status == 3 and amount != 0):
        raise ValueError("refund state and remaining amount disagree")
    return {"ref": identifier(raw.get("bank_transaction_id"), "bank_transaction_id"),
            "trade": identifier(raw.get("rec_trade_id"), "rec_trade_id"),
            "method": identifier(raw.get("payment_method"), "payment_method"),
            "state": STATES[status], "original_twd": original, "amount_twd": amount, "time": at}


def read_pages(pages, scope):
    records = {}
    count = total_pages = None
    pages_read = repeated = 0
    for index, page in enumerate(pages):
        if not isinstance(page, dict) or type(page.get("status")) is not int or page["status"] not in (0, 2):
            raise ValueError("TapPay Record API did not return a successful page")
        size = integer(page.get("total_page_count"), "total_page_count")
        total = integer(page.get("number_of_transactions"), "number_of_transactions")
        rows = page.get("trade_records")
        if (integer(page.get("page"), "page") != index or not isinstance(rows, list) or
                index >= max(1, size) or (index and (size, total) != (total_pages, count))):
            raise ValueError("inconsistent page sequence or totals")
        pages_read, total_pages, count = index + 1, size, total
        for raw in rows:
            record = transaction(raw, scope)
            trade = record["trade"]
            if trade in records:
                if records[trade] != record:
                    raise ValueError("a trade changed across pages; obtain a new snapshot")
                repeated += 1
            records[trade] = record
    if count is None or pages_read != max(1, total_pages) or len(records) != count or (count and not total_pages):
        raise ValueError("incomplete Record API snapshot; verify all pages and unique trades")
    return records.values(), repeated


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_pages(scope, partner_key):
    host = {"sandbox": "sandbox", "production": "prod"}[scope["environment"]]
    endpoint = f"https://{host}.tappaysdk.com/tpc/transaction/query"
    opener = build_opener(NoRedirect())
    index = 0
    while True:
        filters = {"merchant_id": [scope["merchant"]], "currency": "TWD",
                   "time": {k: scope[k] for k in ("start_time", "end_time")}}
        body = {"filters": filters, "partner_key": partner_key, "page": index, "records_per_page": 200,
                "order_by": {"attribute": "time", "is_descending": False}}
        req = Request(endpoint, data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "x-api-key": partner_key})
        with opener.open(req, timeout=30) as response:
            page = json.load(response)
        yield page
        index += 1
        if index >= page["total_page_count"]:
            return


def close_day(db, scope, start, records, repeated):
    args = (scope["merchant"], scope["environment"])
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")
    attempts = {r["reference"]: r for r in db.execute(
        COLUMNS + " AND a.created>=? AND a.created<?", (*args, start, start + DAY_MS))}
    trades = defaultdict(list)
    adjacent_collections = defaultdict(list)
    order_ids = {row["order_id"] for row in attempts.values()}
    for r in records:
        if r["ref"] in attempts:
            trades[r["ref"]].append(r)
        else:
            # A midnight retry may belong to this day's order without belonging to its totals.
            other = db.execute(COLUMNS + " AND a.reference=?", (*args, r["ref"])).fetchone()
            if other is None and start <= r["time"] < start + DAY_MS:
                trades[r["ref"]].append(r)
            elif (other and other["order_id"] in order_ids and r["state"] in COUNTED
                  and r["amount_twd"] > 0):
                adjacent_collections[other["order_id"]].append(r["trade"])
    exceptions = []
    paid_orders = defaultdict(list)
    matched = net = 0
    for ref in sorted(attempts.keys() | trades.keys()):
        local = attempts.get(ref)
        remote = sorted(trades.get(ref, []), key=lambda r: r["trade"])
        reasons = []
        if not local:
            reasons.append("provider_only")
        if not remote:
            reasons.append("local_only")
        if len(remote) > 1:
            reasons.append("multiple_gateway_trades")
        for r in remote:
            if r["state"] in COUNTED:
                net += r["amount_twd"]
                if local and r["amount_twd"] > 0:
                    paid_orders[local["order_id"]].append(r["trade"])
            if local:
                method = "direct_pay" if local["payment_method"] == "card" else local["payment_method"]
                for label, actual, expected in [
                    ("amount_mismatch", r["original_twd"], local["total"]),
                    ("state_mismatch", r["state"], local["state"]),
                    ("method_mismatch", r["method"], method),
                    ("trade_id_mismatch", r["trade"], local["trade_id"]),
                ]:
                    if actual != expected:
                        reasons.append(label)
        if reasons:
            exceptions.append({"reference": ref, "reasons": sorted(set(reasons)),
                               "local": dict(local) if local else None, "gateway": remote})
        else:
            matched += 1
    multiple = []
    for oid, ids in sorted(paid_orders.items()):
        combined = sorted(ids + adjacent_collections[oid])
        if len(combined) > 1:
            multiple.append({"order_id": oid, "trade_ids": combined})
    return {"matched_references": matched, "local_attempts": len(attempts),
            "gateway_trades": sum(map(len, trades.values())), "gateway_net_twd": net,
            "repeated_source_rows": repeated, "exceptions": exceptions, "multiple_collections": multiple,
            "reason_counts": dict(Counter(reason for e in exceptions for reason in e["reasons"]))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="read-only Hey Table SQLite backup")
    parser.add_argument("--day", required=True, help="YYYY-MM-DD in Taiwan")
    parser.add_argument("--merchant", required=True)
    parser.add_argument("--environment", required=True, choices=["sandbox", "production"])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, help="offline JSON with scope and Record API pages")
    source.add_argument("--fetch", action="store_true", help="read TapPay records using TAPPAY_PARTNER_KEY")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)
    try:
        start = day_start(args.day)
        scope = {"environment": args.environment, "merchant": args.merchant, "currency": "TWD",
                 "start_time": start - DAY_MS, "end_time": start + 2 * DAY_MS - 1}
        if args.snapshot:
            data = json.loads(args.snapshot.read_text(encoding="utf-8-sig"))
            if not isinstance(data, dict) or data.get("scope") != scope or not isinstance(data.get("pages"), list):
                raise ValueError("snapshot scope must match the merchant, environment and three-day TWD window")
            pages = data["pages"]
        else:
            key = os.environ.get("TAPPAY_PARTNER_KEY")
            if not key:
                raise ValueError("TAPPAY_PARTNER_KEY is required for --fetch")
            pages = fetch_pages(scope, key)
        with closing(sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            records, repeated = read_pages(pages, scope)
            report = close_day(db, scope, start, records, repeated)
        print(json.dumps({"day": args.day, "scope": scope, **report}, sort_keys=True, ensure_ascii=False, indent=2))
        return 3 if args.strict and (report["exceptions"] or report["multiple_collections"]) else 0
    except (ValueError, OSError, URLError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
