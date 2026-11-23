from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from copy import deepcopy
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Barrier, Thread
import unittest
from urllib.error import HTTPError

from rail import digest, exchange, listed, open_rail, sync, transfer
from station import handler, initialize, render

ROOT = Path(__file__).resolve().parent
ROUTES = json.loads((ROOT / "examples/routes.json").read_text("utf-8"))


@contextmanager
def serving(path, station="hot", drop_before_write=False):
    initialize(path, station)
    class Local(handler(path, station)):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if drop_before_write:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            else:
                super().do_POST()
    with ThreadingHTTPServer(("127.0.0.1", 0), Local) as server:
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.025}, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()


class RailTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "rail.db"
        self.inbox = self.path.with_name("inbox.db")
        self.db = open_rail(self.path)
        self.addCleanup(self.db.close)
        self.orders = json.loads((ROOT / "examples/kitchen.json").read_text("utf-8"))

    def test_atomic_routing_stale_snapshots_and_printable_contents(self):
        broken = deepcopy(self.orders)
        broken[1]["status"] = "preparing"
        with self.assertRaisesRegex(ValueError, "No station"):
            sync(self.db, broken, {k:v for k,v in ROUTES.items() if k != "edamame"})
        self.assertFalse(listed(self.db))
        self.orders[0]["note"] = "<script>例</script> & 多杯"
        self.assertEqual(sync(self.db, self.orders, ROUTES)["added"], 2)
        self.assertEqual(sync(self.db, self.orders, dict(ROUTES, sencha="hot"))["added"], 0)
        bodies = {r["station"]: json.loads(r["ticket"]) for r in self.db.execute("SELECT station,ticket FROM jobs")}
        self.assertEqual(bodies["hot"]["items"], [{"id":"oyakodon","name":"雞肉親子丼","qty":1}])
        self.assertEqual(bodies["bar"]["items"], [{"id":"sencha","name":"日式熱煎茶","qty":2}])
        output = render(bodies["bar"])
        for expected in ("A03 桌內用", "×2", "日式熱煎茶", "&lt;script&gt;例", "&amp;"):
            self.assertIn(expected, output)
        self.assertNotIn("親子丼", output)
        closed = [dict(self.orders[0], status="ready"), dict(self.orders[1], status="cancelled")]
        self.assertEqual(sync(self.db, closed, ROUTES)["skipped"], 2)
        sync(self.db, self.orders, ROUTES)
        self.assertEqual([j["state"] for j in listed(self.db)], ["skipped","skipped"])
        with self.assertRaisesRegex(ValueError, "reused"):
            sync(self.db, [dict(self.orders[0], created=123)], ROUTES)

    def test_process_death_after_durable_station_write(self):
        sync(self.db, self.orders, ROUTES)
        with serving(self.inbox) as url:
            script = """
import os, sys, rail
send = rail.exchange
def stop_after_receipt(*args):
    send(*args)
    os._exit(17)
rail.exchange = stop_after_receipt
rail.transfer(rail.open_rail(sys.argv[1]), "hot", sys.argv[2])
"""
            result = subprocess.run([sys.executable,"-c",script,self.path,url], cwd=ROOT, timeout=15)
            self.assertEqual(result.returncode, 17)
            self.assertEqual(listed(self.db, "hot")[0]["state"], "review")
            self.assertEqual(transfer(self.db, "hot", url), [])
        with serving(self.inbox) as restarted:
            sync(self.db, [dict(self.orders[0], status="ready")], ROUTES)
            self.assertEqual(transfer(self.db, "hot", restarted, True)[0]["state"], "accepted")
            row = self.db.execute("SELECT key,ticket FROM jobs WHERE station='hot'").fetchone()
            self.assertEqual(exchange(restarted, row["key"], row["ticket"])["state"], "accepted")
            with self.assertRaises(HTTPError) as exc:
                exchange(restarted, row["key"], row["ticket"] + b" ")
            exc.exception.close()
            self.assertEqual(exc.exception.code, 409)
        with closing(sqlite3.connect(self.inbox)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM slips WHERE state='accepted'").fetchone()[0], 1)

    def test_disconnect_before_receipt_retry_and_late_delivery(self):
        sync(self.db, self.orders, ROUTES)
        with serving(self.inbox, drop_before_write=True) as url:
            self.assertEqual(transfer(self.db,"hot",url)[0]["state"], "review")
        with serving(self.path.with_name("other.db"),"bar") as wrong:
            self.assertEqual(transfer(self.db,"hot",wrong,True)[0]["state"], "review")
        with serving(self.inbox) as url:
            self.assertEqual(transfer(self.db,"hot",url,True)[0]["state"], "queued")
            sync(self.db,[dict(self.orders[0],status="ready")],ROUTES)
            self.assertEqual(transfer(self.db,"hot",url), [])
            self.assertEqual(transfer(self.db,"hot",url,True)[0]["state"], "skipped")
            row = self.db.execute("SELECT key,ticket FROM jobs WHERE station='hot'").fetchone()
            self.assertEqual(exchange(url,row["key"],row["ticket"])["state"], "closed")
        with closing(sqlite3.connect(self.inbox)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM slips WHERE state='accepted'").fetchone()[0], 0)

    def test_eight_dispatchers_compete_after_a_missing_delivery(self):
        sync(self.db,self.orders,ROUTES)
        with serving(self.inbox, drop_before_write=True) as url:
            transfer(self.db,"hot",url)
        with serving(self.inbox) as url:
            transfer(self.db,"hot",url,True)
            start = Barrier(8)
            def ship(_):
                with closing(open_rail(self.path)) as db:
                    start.wait(timeout=10)
                    return transfer(db,"hot",url)
            with ThreadPoolExecutor(max_workers=8) as workers:
                results = [r["state"] for batch in workers.map(ship,range(8)) for r in batch]
            self.assertEqual(results, ["accepted"])

    def test_close_and_delayed_post_cannot_disagree_at_receiver(self):
        sync(self.db,self.orders,ROUTES)
        body = self.db.execute("SELECT ticket FROM jobs WHERE station='hot'").fetchone()[0]
        with serving(self.inbox) as url, ThreadPoolExecutor(max_workers=2) as workers:
            for i in range(16):
                key = digest(str(i).encode())
                start = Barrier(2)
                def send(method):
                    start.wait(timeout=10)
                    return exchange(url,key,body,method)["state"]
                post, close = workers.map(send, ["POST", "DELETE"])
                self.assertIn(post, ("accepted", "closed"))
                self.assertEqual(post, close)
                self.assertEqual(exchange(url,key)["state"], post)
        with closing(sqlite3.connect(self.inbox)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM slips").fetchone()[0], 16)

    def test_only_a_full_live_read_retires_missing_known_orders(self):
        sync(self.db,self.orders,ROUTES)
        sync(self.db,[],ROUTES)
        self.assertEqual([j["state"] for j in listed(self.db)], ["queued","queued"])
        newer = dict(self.orders[0],id=99,created=2000)
        sync(self.db,[newer],ROUTES)
        self.assertEqual(sync(self.db,[],ROUTES,previously_active=[17,18])["skipped"], 2)
        self.assertEqual(sync(self.db,self.orders,ROUTES)["added"], 0)
        queued = [j["order_id"] for j in listed(self.db,state="queued")]
        self.assertEqual(queued, [99,99])


if __name__ == "__main__":
    unittest.main()
