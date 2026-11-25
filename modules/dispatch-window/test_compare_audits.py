from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from audit import totals
from compare_audits import compare_audits


ROOT = Path(__file__).resolve().parent


class AuditDifferenceTests(unittest.TestCase):
    def setUp(self):
        self.example = json.loads((ROOT / "examples/execution-demo.json").read_bytes())["audit"]

    def test_demo_reconciles_new_dispatches_returns_and_corrected_plans(self):
        before, after = self.example["before"], self.example["after_returns"]
        before["boxes"].reverse()
        before["boxes"][0]["plans"].reverse()
        movement = compare_audits(before, after)
        self.assertEqual(movement, self.example["differences"]["movement"])
        self.assertEqual((movement["new_dispatched_units"], movement["new_restocked_units"]), (2, 1))
        self.assertEqual([(line["shipment_id"], line["dispatched_delta"], line["restocked_delta"])
                          for line in movement["changes"]], [("B1", 0, 1), ("D1", 2, 0)])
        corrected = compare_audits(self.example["plan_conflict"], after)
        self.assertEqual((corrected["resolved_conflicts"], corrected["new_dispatched_units"]), (1, 0))
        self.assertEqual(corrected, self.example["differences"]["corrected"])

    def test_scope_changes_are_reported_without_inventing_movements(self):
        after = self.example["after_returns"]
        expanded = compare_audits(self.example["stock_conflict"], after)
        self.assertEqual((expanded["comparable_boxes"], expanded["added_boxes"], expanded["new_restocked_units"]), (1, 3, 0))
        self.assertEqual(expanded, self.example["differences"]["expanded"])
        narrow = deepcopy(self.example["stock_conflict"])
        narrow["captured_at_ms"] = after["captured_at_ms"] + 1
        removed = compare_audits(after, narrow)
        self.assertEqual((removed["removed_boxes"], removed["new_conflicts"]), (3, 1))
        self.assertTrue(all(row["dispatched_delta"] is None for row in removed["changes"] if row["after"] is None))

    def test_invalid_order_or_rolled_back_shipment_history_cannot_make_a_comparison(self):
        before, after = self.example["before"], self.example["after_returns"]
        for first, second in ((after, before), (before, deepcopy(before))):
            with self.assertRaisesRegex(ValueError, "captured after"):
                compare_audits(first, second)
        altered = deepcopy(after)
        altered["captured_at_ms"] += 1
        altered["boxes"][0]["restocked_units"] = 0
        with self.assertRaisesRegex(ValueError, "contradicts"):
            compare_audits(after, altered)
        altered["boxes"][0].update(recorded_units=None, restocked_units=None, status="pending")
        altered.update(totals(altered["boxes"]))
        with self.assertRaisesRegex(ValueError, "contradicts"):
            compare_audits(after, altered)
        invalid = dict(after, pending_units=99)
        with self.assertRaisesRegex(ValueError, "summary"):
            compare_audits(before, invalid)

    def test_cli_supports_a_saved_snapshot_pair_and_reports_invalid_order(self):
        with TemporaryDirectory() as folder:
            first, second = Path(folder) / "first.json", Path(folder) / "second.json"
            first.write_text(json.dumps(self.example["before"]), encoding="utf-8")
            second.write_text(json.dumps(self.example["after_returns"]), encoding="utf-8")
            command = [sys.executable, "-B", str(ROOT / "compare_audits.py")]
            output = json.loads(subprocess.check_output([*command, first, second], timeout=10))
            self.assertEqual(output, self.example["differences"]["movement"])
            rejected = subprocess.run([*command, second, first], capture_output=True, timeout=10)
            self.assertEqual(rejected.returncode, 2)
            self.assertIn(b"captured after", rejected.stderr)
