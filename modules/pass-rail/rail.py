"""Route accepted Hey Table orders to kitchen stations and reconcile lost acknowledgements."""
import argparse
from contextlib import closing
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
from uuid import uuid4


STATION = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
RANK = {"pending": 0, "preparing": 1, "ready": 2, "completed": 3, "cancelled": 3}


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def open_rail(path):
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS kitchen(namespace TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS coverage(id INTEGER PRIMARY KEY CHECK(id=1), through_id INTEGER NOT NULL);
        INSERT OR IGNORE INTO coverage VALUES(1,0);
        CREATE TABLE IF NOT EXISTS orders(
          id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(
          key TEXT PRIMARY KEY, order_id INTEGER NOT NULL, station TEXT NOT NULL, ticket BLOB NOT NULL,
          state TEXT NOT NULL, attempt TEXT, UNIQUE(order_id, station));
    """)
    with db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT namespace FROM kitchen").fetchone():
            db.execute("INSERT INTO kitchen VALUES (?)", (uuid4().hex,))
    return db


def validate_order(order):
    if type(order["id"]) is not int or order["id"] <= 0 or type(order["created"]) is not int:
        raise ValueError("Invalid order identity")
    if order["mode"] not in ("pickup", "table") or not isinstance(order["note"], str):
        raise ValueError("Invalid service mode or note")
    if order["mode"] == "table":
        if not isinstance(order["table"], str) or not order["table"].strip():
            raise ValueError("Missing table")
    elif order["table"] is not None:
        raise ValueError("Pickup cannot have a table")
    if not isinstance(order["items"], list) or not order["items"] or order["status"] not in RANK:
        raise ValueError("Missing order items or unknown status")
    items = []
    seen = set()
    for line in order["items"]:
        if (not isinstance(line["id"], str) or not line["id"] or line["id"] in seen
                or not isinstance(line["name"], str) or not line["name"]
                or type(line["qty"]) is not int or line["qty"] <= 0):
            raise ValueError("Invalid or repeated dish")
        seen.add(line["id"])
        items.append({key: line[key] for key in ("id", "name", "qty")})
    return dict(id=order["id"], created=order["created"], table=order["table"], mode=order["mode"],
                note=order["note"], items=sorted(items, key=lambda line: line["id"]))


def retire(db, oid):
    db.execute("""UPDATE jobs SET state='review' WHERE order_id=? AND state='queued'
                  AND attempt IS NOT NULL""", (oid,))
    return db.execute("UPDATE jobs SET state='skipped' WHERE order_id=? AND state='queued'", (oid,)).rowcount


def sync(db, orders, routes, complete=False):
    declared = None
    if isinstance(orders, dict):
        if orders.get("format") != "hey-table.station-orders.v1" or type(orders.get("throughId")) is not int:
            raise ValueError("Invalid station export format or order boundary")
        declared, orders, complete = orders["throughId"], orders["orders"], True
    if not isinstance(orders, list) or not isinstance(routes, dict):
        raise ValueError("Expected a kitchen snapshot array and a dish-to-station map")
    if any(not isinstance(v, str) or not STATION.fullmatch(v) for v in routes.values()):
        raise ValueError("Invalid station code")
    added = skipped = 0
    with db:
        db.execute("BEGIN IMMEDIATE")
        namespace = db.execute("SELECT namespace FROM kitchen").fetchone()[0]
        previous_limit = db.execute("SELECT through_id FROM coverage WHERE id=1").fetchone()[0]
        seen = set()
        for order in orders:
            ticket = validate_order(order)
            oid, status = ticket["id"], order["status"]
            if oid in seen:
                raise ValueError(f"Repeated order {oid} in snapshot")
            seen.add(oid)
            fingerprint = digest(encode(ticket))
            prior = db.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
            if prior is None and oid <= previous_limit:
                continue  # Absent when an export already covered this order number.
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise ValueError(f"Order {oid} was reused with different contents")
                if prior["status"] == "archived" or RANK[status] <= RANK[prior["status"]]:
                    continue
            db.execute("""INSERT INTO orders VALUES(?,?,?) ON CONFLICT(id)
                          DO UPDATE SET status=excluded.status""", (oid, fingerprint, status))
            if status == "preparing":
                groups = {}
                for item in ticket["items"]:
                    if item["id"] not in routes:
                        raise ValueError("No station for " + item["id"])
                    groups.setdefault(routes[item["id"]], []).append(item)
                for station, items in groups.items():
                    key = digest(encode([namespace, oid, ticket["created"], station]))
                    body = encode(dict(ticket, station=station, items=items))
                    db.execute("INSERT INTO jobs VALUES(?,?,?,?,'queued',NULL)", (key, oid, station, body))
                    added += 1
            elif RANK[status] >= 2:
                skipped += retire(db, oid)
        if complete:
            limit = max(seen, default=0)
            if declared is not None and declared != limit:
                raise ValueError("Export boundary differs from its highest order ID")
            active = db.execute("SELECT id FROM orders WHERE id<=? AND status IN ('pending','preparing')", (limit,))
            for oid in {row[0] for row in active}.difference(seen):
                db.execute("UPDATE orders SET status='archived' WHERE id=?", (oid,))
                skipped += retire(db, oid)
            db.execute("UPDATE coverage SET through_id=max(through_id,?) WHERE id=1", (limit,))
    return {"added": added, "skipped": skipped}


def listed(db, station=None, state=None):
    return [dict(row) for row in db.execute("""SELECT key,order_id,station,state FROM jobs
        WHERE (? IS NULL OR station=?) AND (? IS NULL OR state=?) ORDER BY order_id,station""",
        (station, station, state, state))]


def exchange(url, key, body=None, method=None):
    req = Request(url.rstrip("/") + "/tickets/" + key, data=body, method=method,
                  headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urlopen(req, timeout=5) as res:
        return json.loads(res.read())


def transfer(db, station, url, reconcile=False):
    results = []
    for job in listed(db, station, "review" if reconcile else "queued"):
        key = job["key"]
        with db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("""SELECT jobs.*,orders.status FROM jobs JOIN orders ON orders.id=jobs.order_id
                                    WHERE key=?""", (key,)).fetchone()
            if current["state"] != ("review" if reconcile else "queued"):
                continue
            attempt = current["attempt"] if reconcile else uuid4().hex
            if not reconcile:
                db.execute("UPDATE jobs SET state='review',attempt=? WHERE key=?", (attempt, key))
        body = current["ticket"]
        state = "review"
        detail = None
        try:
            close = reconcile and current["status"] != "preparing"
            ack = exchange(url, key, body if close or not reconcile else None, "DELETE" if close else None)
            expected = {"key": key, "sha256": digest(body), "station": station}
            if ack == dict(expected, state="accepted"):
                state = "accepted"
            elif ack == dict(expected, state="closed"):
                state = "skipped"
            else:
                detail = "Station acknowledgement does not match the ticket"
        except HTTPError as error:
            # Only the intended station can authoritatively say this particular key is absent.
            with error:
                detail = f"Station returned HTTP {error.code}"
                if reconcile and not close and error.code == 404:
                    try:
                        missing = error.read()
                    except (OSError, http.client.HTTPException):
                        missing = None
                    if missing == encode({"absent": key, "station": station}):
                        state, detail = "queued", None
        except (OSError, URLError, http.client.HTTPException, ValueError) as error:
            detail = str(error)
        with db:
            db.execute("BEGIN IMMEDIATE")
            if state == "queued":
                status = db.execute("SELECT status FROM orders WHERE id=?", (job["order_id"],)).fetchone()[0]
                if status != "preparing":
                    state = "review"
            db.execute("UPDATE jobs SET state=? WHERE key=? AND state='review' AND attempt=?",
                       (state, key, attempt))
            actual = db.execute("SELECT state FROM jobs WHERE key=?", (key,)).fetchone()[0]
        results.append(dict(key=key, state=actual, detail=detail))
    return results


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def pull(url):
    address = urlsplit(url)
    if address.scheme != "https" and not (address.scheme == "http" and
                                          address.hostname in {"127.0.0.1", "localhost", "::1"}):
        raise ValueError("Use HTTPS or a local kitchen URL")
    key = os.environ.get("HEY_TABLE_STAFF_KEY")
    if not key:
        raise ValueError("Set HEY_TABLE_STAFF_KEY to the local kitchen staff key")
    req = Request(url.rstrip("/") + "/api/kitchen", headers={"Authorization": "Bearer " + key})
    with build_opener(NoRedirect()).open(req, timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    commands = parser.add_subparsers(dest="cmd", required=True)
    ingest = commands.add_parser("sync")
    ingest.add_argument("snapshot", type=Path)
    ingest.add_argument("routes", type=Path)
    fetch = commands.add_parser("pull")
    fetch.add_argument("kitchen_url")
    fetch.add_argument("routes", type=Path)
    commands.add_parser("status")
    for name in ("deliver", "reconcile"):
        send = commands.add_parser(name)
        send.add_argument("station")
        send.add_argument("url")
    args = parser.parse_args()
    try:
        with closing(open_rail(args.db)) as db:
            if args.cmd in ("sync", "pull"):
                if args.cmd == "pull":
                    orders = pull(args.kitchen_url)
                else:
                    orders = json.loads(args.snapshot.read_text("utf-8"))
                result = sync(db, orders, json.loads(args.routes.read_text("utf-8")), complete=args.cmd == "pull")
            elif args.cmd == "status":
                result = listed(db)
            else:
                result = transfer(db, args.station, args.url, args.cmd == "reconcile")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if args.cmd in ("deliver","reconcile") and any(r["state"] == "review" for r in result) else 0
    except (KeyError, TypeError, ValueError, OSError, sqlite3.Error) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    sys.exit(main())
