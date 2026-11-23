"""Crash and replay the same shipment on either side of commit and expiry."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from http.client import HTTPConnection, RemoteDisconnected
import json
import multiprocessing
from pathlib import Path
import runpy
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
from threading import Barrier

from server import serve


LEGACY = "ce5bf2d652d6c77f5018a50aca80a5ae5fcf7644"
SHIPMENT = "/reservations/order/fulfillments"
RECEIPT = dict(reservation_id="order", shipment_id="box-A", quantity=3, held_after=4)


def check(actual, expected, label):
    if actual != expected:
        raise ValueError(f"{label}: expected {expected}, got {actual}")


def request(port, path, payload=None, key=None):
    headers = {"Content-Type":"application/json"}
    if key is not None:
        headers["Idempotency-Key"] = key
    with closing(HTTPConnection("127.0.0.1", port, timeout=15)) as client:
        client.request("GET" if payload is None else "POST", path,
                       body=None if payload is None else json.dumps(payload), headers=headers)
        response = client.getresponse()
        body = response.read()
        return response.status, json.loads(body) if path != "/metrics" else None


@contextmanager
def service(checkout, database, clock, boundary=None):
    context = multiprocessing.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    child = context.Process(target=serve, args=(checkout, database, clock, boundary, writer), daemon=True)
    child.start()
    writer.close()
    try:
        if not reader.poll(30):
            raise TimeoutError("test server did not bind a local socket")
        port = reader.recv()
        # /metrics never runs expiry cleanup, so the concurrent replay is the first inventory request.
        check(request(port, "/metrics")[0], 200, "server readiness")
        yield port, child
    finally:
        reader.close()
        if child.is_alive():
            child.terminate()
        child.join(10)
        if child.is_alive():
            child.kill()
            child.join()
        child.close()


def seed(checkout, folder, database):
    original = subprocess.check_output(["git", "-C", str(checkout), "show", LEGACY+":stockroom/store.py"])
    source = folder/"legacy_store.py"
    source.write_bytes(original)
    old = runpy.run_path(str(source))["Store"](database)
    old.initialize()
    _, created = old.reserve("legacy", "KIT-01", 2)
    check(created, True, "original release creates the two-unit legacy hold")


def inspect(database):
    with closing(sqlite3.connect(database.as_uri()+"?mode=ro", uri=True)) as db:
        check(db.execute("PRAGMA integrity_check").fetchall(), [("ok",)], "database integrity")
        check(db.execute("PRAGMA foreign_key_check").fetchall(), [], "foreign key integrity")
        capacity, available = db.execute("SELECT capacity,available FROM products WHERE sku='KIT-01'").fetchone()
        boxes = db.execute("SELECT shipment_id,quantity,held_after FROM fulfillments ORDER BY shipment_id").fetchall()
        shipped, = db.execute("SELECT shipped FROM reservations WHERE id='order'").fetchone()
        return dict(capacity=capacity, available=available, shipped=shipped, boxes=[list(box) for box in boxes])


def scenario(checkout, boundary, restart_time, workers):
    with TemporaryDirectory(prefix="commit-gap-") as directory:
        folder = Path(directory).resolve()
        database = folder/"stock.db"
        seed(checkout, folder, database)
        with service(checkout, database, 100, boundary) as (port, child):
            status, order = request(port, "/reservations", dict(sku="KIT-01",quantity=7), "order")
            check((status, order["expires_at_ms"]), (201, 110000), "hold deadline")
            try:
                request(port, SHIPMENT, dict(quantity=3), "box-A")
            except (RemoteDisconnected, ConnectionResetError, ConnectionAbortedError):
                pass
            else:
                raise ValueError("the interrupted shipment unexpectedly returned an HTTP response")
            child.join(10)
            check(child.exitcode, 81 if boundary == "before_commit" else 82, "fault boundary exit code")

        committed = boundary == "before_reply"
        raw = inspect(database)
        box = [["box-A",3,4]]
        check(raw, dict(capacity=17 if committed else 20, available=11, shipped=3 if committed else 0,
                        boxes=box if committed else []), "durable state before restart")
        expired = restart_time >= 110
        with service(checkout, database, restart_time) as (port, _):
            gate = Barrier(workers, timeout=15)

            def retry(_):
                gate.wait()
                return request(port, SHIPMENT, dict(quantity=3), "box-A")

            with ThreadPoolExecutor(max_workers=workers) as pool:
                replies = list(pool.map(retry, range(workers)))
            codes = Counter(code for code, _ in replies)
            sent = committed or not expired
            if committed:
                expected_codes = {200: workers}
            elif expired:
                expected_codes = {409: workers}
            else:
                expected_codes = {201: 1, 200: workers-1}
            check(codes, Counter(expected_codes), "parallel replay statuses")
            for code, body in replies:
                if code == 409:
                    check(body, {"detail":"Insufficient held units for shipment"}, "expired shipment conflict")
                else:
                    check(body, RECEIPT, "historical shipment receipt")
            if sent:
                status, body = request(port, SHIPMENT, dict(quantity=2), "box-A")
                check((status, body), (409, {"detail":"Shipment key already used with different quantity"}),
                      "changed quantity conflicts with the recorded shipment")
            _, product = request(port, "/inventory")
            _, packing = request(port, SHIPMENT)
            _, legacy = request(port, "/reservations/legacy")
            check((legacy["state"], legacy["held"], legacy["expires_at_ms"]), ("held",2,None), "legacy hold")
            check((packing["reservation"]["held"], packing["reservation"]["state"]),
                  (0,"expired") if expired else (4,"held"), "remaining hold")
            check([(r["shipment_id"],r["dispatched"]) for r in packing["boxes"]],
                  [("box-A",3)] if sent else [], "packing statement")
            available = (15 if sent else 18) if expired else 11
            check(product, [dict(sku="KIT-01",capacity=17 if sent else 20,available=available)], "inventory")
            final = inspect(database)
            check(final, dict(capacity=17 if sent else 20, available=available, shipped=3 if sent else 0,
                              boxes=box if sent else []), "durable final state")
        return dict(boundary=boundary, restartSeconds=restart_time, beforeRestart=raw,
                    replayStatuses=dict(codes), final=final, legacyHeld=legacy["held"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom", type=Path, help="Stockroom git checkout with original commit available")
    parser.add_argument("--workers", type=int, default=8, choices=range(1,33), metavar="1-32")
    args = parser.parse_args()
    cases = [scenario(args.stockroom.resolve(), boundary, clock, args.workers)
             for boundary in ("before_commit","before_reply") for clock in (109,110)]
    print(json.dumps(cases, indent=2))


if __name__ == "__main__":
    main()
