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


def seed(directory, migrations=None):
    directory.mkdir()
    db_path = directory / "restaurant.db"
    with closing(sqlite3.connect(db_path)) as db:
        if migrations:
            journal = json.loads((migrations / "meta/_journal.json").read_text(encoding="utf8"))
            for item in journal["entries"]:
                db.executescript((migrations / (item["tag"] + ".sql")).read_text(encoding="utf8"))
        else:
            db.executescript(SCHEMA)
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--migrations", type=Path)
    args = parser.parse_args()
    seed(args.directory, args.migrations)
