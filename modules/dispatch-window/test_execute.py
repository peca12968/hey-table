from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

from dispatch import plan
from execute import execute, now_ms


ROOT = Path(__file__).resolve().parent


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.report = plan(json.loads((ROOT / "examples/morning.json").read_bytes()))

    def test_preview_and_replanned_box_order_keep_the_same_batch_key(self):
        first = execute(self.report, clock=lambda: 107000)
        self.assertEqual([result["state"] for result in first["results"]], ["due", "waiting", "waiting"])
        edited = deepcopy(self.report)
        order = edited["scheduled"][0]
        order["dispatch"]["boxes"].reverse()
        order["dispatch_ms"] += 25
        second = execute(edited, clock=lambda: 107000, selected=("B",))
        self.assertEqual(second["results"][0]["batch_id"], first["results"][0]["batch_id"])
        self.assertEqual(second["results"][0]["state"], "waiting")
        self.assertEqual(second["confirmed_units"], 0)

    def test_invalid_order_or_foreign_receipt_never_leads_to_a_post(self):
        calls = []

        def request(path, body=None, headers=None):
            calls.append((path, body))
            return 200, {"batch_id": "different", "boxes": []}

        bad = deepcopy(self.report)
        bad["scheduled"][-1]["units"] += 1
        with self.assertRaises(ValueError):
            execute(bad, request, selected=("B",))
        with self.assertRaises(ValueError):
            execute(self.report, request, selected=("A",))
        self.assertEqual(calls, [])
        report = execute(self.report, request, clock=lambda: 107000, selected=("B",))
        self.assertEqual([result["state"] for result in report["results"]], ["retry"])
        self.assertEqual(len(calls), 1)
        self.assertIsNone(calls[0][1])
        self.assertEqual(report["confirmed_units"], 0)

    def test_cli_previews_submits_and_recovers_over_http(self):
        calls = []
        receipts = {}

        class StockroomHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send_json(self, status, data):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode("utf-8"))

            def do_GET(self):
                calls.append(("GET", self.path))
                receipt = receipts.get(self.path.removeprefix("/dispatch-batches/"))
                self.send_json(200 if receipt else 404, receipt)

            def do_POST(self):
                batch_id = self.headers["Idempotency-Key"]
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(("POST", self.path, body))
                receipt = {"batch_id": batch_id, "boxes": [{**box, "held_after": 0} for box in body["boxes"]]}
                receipts[batch_id] = receipt
                self.send_json(201, receipt)

        server = ThreadingHTTPServer(("127.0.0.1", 0), StockroomHandler)
        runner = Thread(target=server.serve_forever, daemon=True)
        runner.start()
        try:
            current = now_ms()
            job = self.report["scheduled"][0]
            job.update(pack_start_ms=current - 5000, dispatch_ms=current, deadline_ms=current + 60000)
            report = {"start_ms": current - 5000, "cutoff_ms": current + 60000, "scheduled": [job], "ship_units": 4}
            with TemporaryDirectory() as directory:
                path = Path(directory) / "plan.json"
                path.write_text(json.dumps(report), encoding="utf-8")
                endpoint = f"http://127.0.0.1:{server.server_port}"
                cli = [sys.executable, "-B", str(ROOT / "execute.py"), str(path), "--stockroom", endpoint]
                preview = json.loads(subprocess.check_output(cli, timeout=10))
                self.assertEqual(preview["results"][0]["state"], "due")
                self.assertEqual(calls, [])
                first = json.loads(subprocess.check_output([*cli, "--confirm", "--reservation", "B"], timeout=10))
                again = json.loads(subprocess.check_output([*cli, "--confirm"], timeout=10))
            key = first["results"][0]["batch_id"]
            path = "/dispatch-batches/" + key
            self.assertEqual(calls, [
                ("GET", path),
                ("POST", "/dispatch-batches", {"boxes": job["dispatch"]["boxes"],
                                               "window": {"not_before_ms": current, "before_ms": current + 60000}}),
                ("GET", path),
            ])
            self.assertEqual(first["results"][0]["state"], "dispatched")
            self.assertEqual(again["results"][0]["state"], "recovered")
            self.assertEqual(first["results"][0]["receipt"], again["results"][0]["receipt"])
            self.assertEqual(again["confirmed_units"], 4)
        finally:
            server.shutdown()
            server.server_close()
            runner.join()
