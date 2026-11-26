import csv
import io
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from dispatch import plan
from execute import execute, prepare
from load_scan import labels_for, verify_load


ROOT = Path(__file__).resolve().parent


class LoadScanTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan(json.loads((ROOT / "examples/morning.json").read_bytes()))
        self.jobs = prepare(self.plan, ("B",))

    def test_line_numbers_distinguish_invalid_wrong_quantity_and_duplicate_scans(self):
        log = "  DW1/B/B1/2 \r\n\r\nDW1/D/D1/2\r\nDW1/B/B1/2\r\nDW1/B/B2/1\r\nwrong\r\nDW1/B/B2/1000001"
        result = verify_load(self.jobs, log)
        self.assertFalse(result["ready"])
        self.assertEqual((result["verified_boxes"], result["verified_units"]), (1, 2))
        self.assertEqual(result["missing"], [labels_for(self.jobs)[1]])
        self.assertEqual([(issue["line"], issue["reason"]) for issue in result["issues"]], [
            (3, "unexpected_box"), (4, "duplicate_scan"), (5, "quantity_mismatch"),
            (6, "invalid_code"), (7, "invalid_code"),
        ])
        self.assertEqual(result["issues"][1]["first_line"], 1)
        self.assertEqual(result["issues"][2]["expected_quantity"], 2)

    def test_incomplete_load_does_not_touch_stockroom_and_verified_replay_reuses_receipt(self):
        calls = []
        job = self.jobs[0]
        receipt = {"batch_id": job["batch_id"], "boxes": [{**box, "held_after": 0} for box in job["boxes"]]}

        def request(path, body=None, headers=None):
            calls.append(path)
            return 200, receipt

        bad = execute(self.plan, request, clock=lambda: 107000, selected=("B",), scan_log="DW1/B/B1/2")
        self.assertEqual(calls, [])
        self.assertEqual(bad["results"], [])
        self.assertFalse(bad["load_check"]["ready"])
        good = execute(self.plan, request, clock=lambda: 109000, selected=("B",), scan_log="DW1/B/B2/2\nDW1/B/B1/2")
        self.assertEqual(calls, ["/dispatch-batches/" + job["batch_id"]])
        self.assertTrue(good["load_check"]["ready"])
        self.assertEqual(good["results"][0]["receipt"], receipt)

    def test_cli_exports_compatible_labels_and_reads_bom_scanner_logs(self):
        with TemporaryDirectory() as directory:
            report, scans = Path(directory) / "plan.json", Path(directory) / "scans.txt"
            report.write_text(json.dumps(self.plan), encoding="utf-8")
            command = [sys.executable, "-B", str(ROOT / "execute.py"), str(report), "--reservation", "B"]
            exported = subprocess.check_output([*command, "--labels"], timeout=10).decode()
            self.assertEqual(list(csv.DictReader(io.StringIO(exported))), [
                {**box, "quantity": str(box["quantity"])} for box in labels_for(self.jobs)
            ])
            scans.write_text("DW1/B/B2/2\n", encoding="utf-8-sig")
            result = subprocess.run([*command, "--scan-log", scans], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            load = json.loads(result.stdout)["load_check"]
            self.assertEqual(load["missing"], [labels_for(self.jobs)[0]])
            self.assertEqual(load["issues"], [])

    def test_workbench_export_keeps_all_verified_jobs_and_excludes_unverified_boxes(self):
        jobs = prepare(self.plan, ())
        with TemporaryDirectory() as directory:
            report, scans = Path(directory) / "plan.json", Path(directory) / "scans.txt"
            report.write_text(json.dumps(self.plan), encoding="utf-8")
            command = [sys.executable, "-B", str(ROOT / "execute.py"), str(report), "--export-workbench"]
            scans.write_text("DW1/B/B1/2\n", encoding="utf-8")
            blocked = subprocess.run([*command, "--scan-log", scans], capture_output=True, timeout=10)
            self.assertEqual(blocked.returncode, 1)
            self.assertEqual(json.loads(blocked.stdout)["jobs"], [])
            self.assertEqual(subprocess.run(command, capture_output=True, timeout=10).returncode, 2)
            scans.write_text("\n".join(box["code"] for box in reversed(labels_for(jobs))), encoding="utf-8-sig")
            valid = subprocess.check_output([*command, "--scan-log", scans], timeout=10)
            manifest = json.loads(valid)
            self.assertEqual(manifest["format"], "dispatch-window.workbench.v1")
            self.assertEqual(manifest["jobs"], jobs)
            self.assertTrue(manifest["load_check"]["ready"])
            self.assertEqual(manifest["load_check"]["verified_units"], self.plan["ship_units"])
            self.assertEqual(subprocess.run([*command, "--scan-log", scans, "--confirm", "--stockroom",
                                             "http://127.0.0.1:1"], capture_output=True, timeout=10).returncode, 2)
