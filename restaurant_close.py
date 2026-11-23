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


def payment_method_totals(trades):
    totals = {}
    for group in trades:
        for trade in group:
            method = trade["method"]
            row = totals.setdefault(method, {"trades": 0, "states": Counter(),
                                             "gross_twd": 0, "refunded_twd": 0, "net_twd": 0})
            state = trade["state"]
            row["trades"] += 1
            row["states"][state] += 1
            if state in COUNTED:
                net = trade["amount_twd"]
                gross = trade["original_twd"] if state in ("partial", "refunded") else net
                row["gross_twd"] += gross
                row["refunded_twd"] += gross - net
                row["net_twd"] += net
    return totals


def reconcile_merchant(db, scope, start, records, repeated):
    args = (scope["merchant"], scope["environment"])
    attempts = {r["reference"]: r for r in db.execute(
        COLUMNS + " AND a.created>=? AND a.created<?", (*args, start, start + DAY_MS))}
    trades = defaultdict(list)
    collections = []
    for r in records:
        local = attempts.get(r["ref"])
        today = local is not None
        if not today:
            local = db.execute(COLUMNS + " AND a.reference=?", (*args, r["ref"])).fetchone()
        if today or (local is None and start <= r["time"] < start + DAY_MS):
            trades[r["ref"]].append(r)
        # Keep a nearby retry for duplicate detection without adding it to this day's net.
        if local is not None and r["state"] in COUNTED and r["amount_twd"] > 0:
            collections.append((local["order_id"], {"merchant": scope["merchant"], "reference": r["ref"],
                                                    "trade_id": r["trade"], "in_day": today}))
    exceptions = []
    matched = 0
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
    by_method = payment_method_totals(trades.values())
    report = {"gateway_by_method": by_method, "matched_references": matched, "local_attempts": len(attempts),
              "gateway_trades": sum(map(len, trades.values())),
              "gateway_net_twd": sum(row["net_twd"] for row in by_method.values()),
              "repeated_source_rows": repeated, "exceptions": exceptions,
              "reason_counts": dict(Counter(reason for e in exceptions for reason in e["reasons"]))}
    return report, trades.values(), collections


def reconcile_accounts(db, scopes, start, inputs):
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")
    by_merchant = {}
    trade_groups = []
    collections = defaultdict(list)
    for merchant, scope in sorted(scopes.items()):
        report, groups, payments = reconcile_merchant(db, scope, start, *inputs[merchant])
        by_merchant[merchant] = report
        trade_groups.extend(groups)
        for order_id, payment in payments:
            collections[order_id].append(payment)
    multiple = []
    for order_id, payments in sorted(collections.items()):
        if len(payments) > 1 and any(p["in_day"] for p in payments):
            multiple.append({"order_id": order_id, "payments": sorted(
                payments, key=lambda p: (p["merchant"], p["trade_id"]))})
    if len(by_merchant) == 1:
        report, = by_merchant.values()
        report["multiple_collections"] = [{"order_id": entry["order_id"], "trade_ids": sorted(
            p["trade_id"] for p in entry["payments"])} for entry in multiple]
        return report
    exceptions = []
    reason_counts = Counter()
    for merchant, report in by_merchant.items():
        exceptions.extend(dict(issue, merchant=merchant) for issue in report.pop("exceptions"))
        reason_counts.update(report["reason_counts"])
    totals = {key: sum(report[key] for report in by_merchant.values()) for key in
              ("matched_references", "local_attempts", "gateway_trades", "gateway_net_twd", "repeated_source_rows")}
    return {**totals, "gateway_by_method": payment_method_totals(trade_groups), "by_merchant": by_merchant,
            "multiple_collections": multiple, "exceptions": exceptions, "reason_counts": dict(reason_counts)}


def close_day(db, scope, start, records, repeated):
    """Reconcile one validated merchant feed against a read-only restaurant connection."""
    merchant = scope["merchant"]
    return reconcile_accounts(db, {merchant: scope}, start, {merchant: (records, repeated)})


def load_inputs(scopes, snapshots):
    inputs = {}
    if snapshots:
        for path in snapshots:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            scope = data.get("scope") if isinstance(data, dict) else None
            merchant = scope.get("merchant") if isinstance(scope, dict) else None
            if (not isinstance(merchant, str) or merchant not in scopes or scope != scopes[merchant]
                    or not isinstance(data.get("pages"), list)):
                raise ValueError("snapshot scope must match the requested merchant, environment and three-day TWD window")
            if merchant in inputs:
                raise ValueError(f"{merchant}: duplicate merchant snapshot")
            inputs[merchant] = read_pages(data["pages"], scope)
        missing = sorted(scopes.keys() - inputs.keys())
        if missing:
            raise ValueError(f"Missing snapshot for {', '.join(missing)}")
    else:
        key = os.environ.get("TAPPAY_PARTNER_KEY")
        if not key:
            raise ValueError("TAPPAY_PARTNER_KEY is required for --fetch")
        for merchant, scope in sorted(scopes.items()):
            inputs[merchant] = read_pages(fetch_pages(scope, key), scope)
    owners = {}
    for merchant, (records, _) in inputs.items():
        for record in records:
            trade = record["trade"]
            if owners.setdefault(trade, merchant) != merchant:
                raise ValueError(f"{trade}: gateway trade ID appears under multiple merchants")
    return inputs


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="read-only Hey Table SQLite backup")
    parser.add_argument("--day", required=True, help="YYYY-MM-DD in Taiwan")
    parser.add_argument("--merchant", required=True, action="append", help="merchant ID, repeat for a combined close")
    parser.add_argument("--environment", required=True, choices=["sandbox", "production"])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, action="append", help="one offline JSON per requested merchant")
    source.add_argument("--fetch", action="store_true", help="read TapPay records using TAPPAY_PARTNER_KEY")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)
    try:
        start = day_start(args.day)
        window = {"environment": args.environment, "currency": "TWD",
                  "start_time": start - DAY_MS, "end_time": start + 2 * DAY_MS - 1}
        merchants = sorted({identifier(m, "merchant ID") for m in args.merchant})
        scopes = {m: dict(window, merchant=m) for m in merchants}
        inputs = load_inputs(scopes, args.snapshot)
        with closing(sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            report = reconcile_accounts(db, scopes, start, inputs)
        scope = scopes[merchants[0]] if len(merchants) == 1 else dict(window, merchants=merchants)
        print(json.dumps({"day": args.day, "scope": scope, **report}, sort_keys=True, ensure_ascii=False, indent=2))
        return 3 if args.strict and (report["exceptions"] or report["multiple_collections"]) else 0
    except (ValueError, OSError, URLError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
