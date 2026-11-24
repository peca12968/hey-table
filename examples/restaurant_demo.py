"""Write synthetic restaurant test inputs to a new directory, optionally using Hey Table migrations."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from datetime import datetime, timezone, timedelta

DAY = "2026-11-23"
START = int(datetime(2026, 11, 23, tzinfo=timezone(timedelta(hours=8))).timestamp()) * 1000
DAY_MS = 86_400_000
MERCHANT = "demo-restaurant"
SCOPE = {"merchant": MERCHANT, "environment": "sandbox", "currency": "TWD",
         "start_time": START - DAY_MS, "end_time": START + 2 * DAY_MS - 1}
SCHEMA = """
CREATE TABLE orders(id INTEGER PRIMARY KEY, token TEXT, mode TEXT, note TEXT, items TEXT,
    total INTEGER, created INTEGER, payment_env TEXT, payment_method TEXT);
CREATE TABLE payment_attempts(order_id INTEGER, reference TEXT UNIQUE, trade_id TEXT,
    merchant TEXT, state TEXT, created INTEGER);
"""


def restaurant_database(directory, migrations):
    directory.mkdir()
    db_path = directory / "restaurant.db"
    with closing(sqlite3.connect(db_path)) as db:
        if migrations:
            journal = json.loads((migrations / "meta/_journal.json").read_text(encoding="utf8"))
            for item in journal["entries"]:
                db.executescript((migrations / (item["tag"] + ".sql")).read_text(encoding="utf8"))
        else:
            db.executescript(SCHEMA)
    return db_path


def seed(directory, migrations=None):
    db_path = restaurant_database(directory, migrations)
    with closing(sqlite3.connect(db_path)) as db:
        # Order 2 has two references after a retry. Both have a gateway collection.
        for oid, env, method, amount in [(1,"sandbox","card",190), (2,"sandbox","line_pay",120),
                (3,"sandbox","px_pay_plus",90), (4,"sandbox","jko_pay",60),
                (5,"demo","line_pay",999), (6,"production","card",999)]:
            db.execute("""INSERT INTO orders(id,token,mode,note,items,total,created,payment_env,payment_method)
                VALUES (?,?,'pickup','','[]',?,?,?,?)""", (oid, f"private-ticket-{oid}", amount, START, env, method))
        for row in [(1,"C1","C-ONE","paid",-1), (2,"L1","L-ONE","failed",5),
                    (2,"L2","L-TWO","paid",10), (3,"P1","P-ONE","partial",20),
                    (4,"J1",None,"pending",30), (5,"D1",None,"paid",35), (6,"LIVE",None,"paid",40)]:
            oid, ref, trade, state, offset = row
            db.execute("""INSERT INTO payment_attempts(order_id,reference,trade_id,state,created,merchant)
                VALUES (?,?,?,?,?,?)""", (oid, ref, trade, state, START + offset, MERCHANT))
        db.commit()
    def trade(ref, trade_id, method, code, original, amount, offset):
        return dict(bank_transaction_id=ref, rec_trade_id=trade_id, merchant_id=MERCHANT,
                    payment_method=method, record_status=code, original_amount=original,
                    amount=amount, time=START+offset)
    rows = [trade("C1","C-ONE","direct_pay",1,190,190,1),
            trade("L1","L-ONE","line_pay",1,120,120,6),
            trade("L2","L-TWO","line_pay",1,120,120,11),
            trade("P1","P-ONE","px_pay_plus",2,95,80,22),
            trade("X1","X-ONE","jko_pay",1,40,40,28)]
    pages = [dict(status=0, page=i, total_page_count=2, number_of_transactions=5,
                  trade_records=rows[i*3:i*3+3]) for i in range(2)]
    snapshot = directory / "records.json"
    snapshot.write_text(json.dumps({"scope": SCOPE, "pages": pages}, indent=2), encoding="utf8")
    return db_path, snapshot


WALLET = "demo-wallet"


def seed_split(directory, migrations=None):
    db_path, base = seed(directory, migrations)
    moved = {"L1", "P1"}
    with closing(sqlite3.connect(db_path)) as db, db:
        db.execute("UPDATE payment_attempts SET merchant=? WHERE reference IN (?,?)", (WALLET, *sorted(moved)))
    data = json.loads(base.read_text(encoding="utf8"))
    records = [r for page in data["pages"] for r in page["trade_records"]]
    wallet = directory / "wallet.json"
    for merchant, path in [(MERCHANT, base), (WALLET, wallet)]:
        rows = [dict(r, merchant_id=merchant) for r in records
                if (r["bank_transaction_id"] in moved) == (merchant == WALLET)]
        page = {"status": 0, "page": 0, "total_page_count": 1, "number_of_transactions": len(rows),
                "trade_records": rows}
        path.write_text(json.dumps({"scope": dict(SCOPE, merchant=merchant), "pages": [page]}, indent=2),
                        encoding="utf8")
    return db_path, base, wallet


def seed_funding(directory, migrations=None):
    db_path = restaurant_database(directory, migrations)
    # Each tuple is one synthetic local payment and its matching gateway record.
    cases = [
        (MERCHANT, "pi_wallet", 2, 200, 140, {"point": 40, "credit_card": 160},
         {"returned_reward_amount": 10, "returned_real_amount": 50}),
        (WALLET, "pi_wallet", 1, 100, 100, {"point": 30, "bank_account": 70}, None),
        (MERCHANT, "easy_wallet", 1, 80, 80, {"balance": 80}, None),
        (WALLET, "plus_pay", 3, 90, 0, {"credit_card": 20, "balance": 70}, None),
        (WALLET, "px_pay_plus", 1, 60, 60, {"point": 0, "balance": ""}, None),
        (MERCHANT, "line_pay", 1, 120, 120, {"discount": 20, "bank_account": 100}, None),
        (WALLET, "jko_pay", 1, 50, 50, {"point": 10}, None),
        (MERCHANT, "direct_pay", 1, 19, 19, None, None),
        (MERCHANT, "pi_wallet", 4, 999, 999, None, None),
    ]
    states = {1: "paid", 2: "partial", 3: "refunded", 4: "pending"}
    feeds = {MERCHANT: [], WALLET: []}
    with closing(sqlite3.connect(db_path)) as db, db:
        for i, (merchant, method, state, gross, net, pay, refund) in enumerate(cases, 1):
            ref, trade, moment = f"F{i}", f"TRADE-{i}", START + i
            local_method = "card" if method == "direct_pay" else method
            db.execute("""INSERT INTO orders(id,token,mode,note,items,total,created,payment_env,payment_method)
                          VALUES (?,?,'pickup','','[]',?,?,'sandbox',?)""",
                       (i, f"private-ticket-{i}", gross, moment, local_method))
            db.execute("""INSERT INTO payment_attempts(order_id,reference,trade_id,state,created,merchant)
                          VALUES (?,?,?,?,?,?)""", (i, ref, trade, states[state], moment, merchant))
            row = dict(bank_transaction_id=ref, rec_trade_id=trade, merchant_id=merchant, payment_method=method,
                       record_status=state, original_amount=gross, amount=net, time=moment)
            if pay is not None:
                row["pay_info"] = pay
            if refund is not None:
                row["refund_info"] = refund
            feeds[merchant].append(row)
    paths = []
    for merchant, rows in feeds.items():
        path = directory / (merchant + ".json")
        page = {"status": 0, "page": 0, "total_page_count": 1,
                "number_of_transactions": len(rows), "trade_records": rows}
        path.write_text(json.dumps({"scope": dict(SCOPE, merchant=merchant), "pages": [page]}, indent=2),
                        encoding="utf8")
        paths.append(path)
    return db_path, *paths


def seed_activity(directory, migrations=None):
    db_path, _ = seed(directory, migrations)
    with closing(sqlite3.connect(db_path)) as db, db:
        # The LINE Pay order was started yesterday. Its two refunds are today's bank activity.
        db.execute("UPDATE payment_attempts SET created=? WHERE reference='L2'", (START - 1000,))
        db.execute("UPDATE orders SET created=? WHERE id=2", (START - 1000,))
        db.execute("UPDATE payment_attempts SET merchant=? WHERE reference='P1'", (WALLET,))
        db.execute("UPDATE orders SET total=95 WHERE id=3")
    scope = {"environment":"sandbox", "merchant_ids":sorted([MERCHANT,WALLET]),
             "start_time_millis":START, "end_time_millis":START + DAY_MS - 1,
             "transaction_actions":["CAPTURE","REFUND"]}

    def row(merchant, ref, trade, method, action, amount, auth, at, success=True, refund_ref=None):
        return dict(merchant_id=merchant, bank_transaction_id=ref, rec_trade_id=trade,
                    payment_method=method, transaction_action=action, trade_amount=amount,
                    auth_amount=auth, bank_transaction_millis=at, millis=at-10, transaction_result=success,
                    bank_refund_order_number=refund_ref, currency="TWD", partial_card_number="fixture-sensitive")

    rows = [
        row(MERCHANT,"L2","L-TWO","line_pay","REFUND",20,120,START),
        row(WALLET,"P1","P-ONE","px_pay_plus","CAPTURE",95,95,START+50),
        row(MERCHANT,"L2","L-TWO","line_pay","REFUND",30,120,START+100),
        row(MERCHANT,"L2","L-TWO","line_pay","REFUND",10,120,START+150,success=False),
        row(WALLET,"P1","P-ONE","px_pay_plus","REFUND",15,95,START+DAY_MS-1,refund_ref="PX-R-1"),
    ]
    pages = [dict(status=0, page=index, total_page_count=2, number_of_transactions=5,
                  reconciliation_datas=rows[index*3:index*3+3]) for index in range(2)]
    path = directory / "bank-activity.json"
    path.write_text(json.dumps({"scope":scope, "pages":pages}, indent=2), encoding="utf8")
    return db_path, path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--migrations", type=Path)
    scenario = parser.add_mutually_exclusive_group()
    scenario.add_argument("--split-merchants", action="store_true", help="place a payment retry in a second merchant account")
    scenario.add_argument("--wallet-funding", action="store_true", help="generate six wallet funding and refund examples")
    scenario.add_argument("--bank-activity", action="store_true", help="generate captures and cross-day refunds")
    args = parser.parse_args()
    if args.wallet_funding:
        seed_funding(args.directory, args.migrations)
    elif args.bank_activity:
        seed_activity(args.directory, args.migrations)
    elif args.split_merchants:
        seed_split(args.directory, args.migrations)
    else:
        seed(args.directory, args.migrations)
