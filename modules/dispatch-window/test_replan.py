from copy import deepcopy
import json
from pathlib import Path
import unittest

from replan import replan


class ReplanTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(Path(__file__).with_name("examples").joinpath("morning.json").read_bytes())
        self.capture = {"captured_at_ms": 112000, "holds": deepcopy(self.manifest["holds"])}
        self.requests = []

    def request(self, path, body):
        self.requests.append((path, body))
        return 200, self.capture

    def test_new_window_uses_only_fresh_holds_and_keeps_partial_boxes_and_station_rules(self):
        a, b, c, _ = self.capture["holds"]
        a["reservation"].update(state="expired", held=0)
        b["reservation"].update(held=2, expires_at_ms=125000)
        b["boxes"] = [{"shipment_id": "B1", "dispatched": 2}]
        c["boxes"] = [{"shipment_id": "C1", "dispatched": 2}]
        b_work = self.manifest["work"][1]
        b_work["allowed_stations"] = [2]
        b_work["boxes"][0]["pack_ms"] = 2000
        b_work["boxes"][1]["pack_ms"] = 3000
        pauses = [[], [{"start_ms": 113000, "end_ms": 114000}]]
        window = {"start_ms": 113000, "cutoff_ms": 120000, "stations": 2, "station_pauses": pauses}
        original = deepcopy(self.manifest)
        report = replan(self.manifest, window, self.request)
        self.assertEqual(self.manifest, original)
        self.assertEqual(self.requests, [("/packing-snapshots", {"reservation_ids": ["A", "B", "C", "D"]})])
        self.assertEqual((report["captured_at_ms"], report["start_ms"], report["ship_units"]), (112000, 113000, 4))
        self.assertEqual(report["omitted"], [
            {"reservation_id": "A", "reason": "hold_closed"},
            {"reservation_id": "C", "reason": "shipment_quantity_conflict"},
        ])
        self.assertEqual(report["shipment_conflicts"], [
            {"reservation_id": "C", "shipment_id": "C1", "planned_quantity": 3, "recorded_quantity": 2},
        ])
        self.assertEqual(report["already_dispatched"], [{"reservation_id": "B", "shipment_id": "B1", "quantity": 2}])
        remaining = next(job for job in report["scheduled"] if job["reservation_id"] == "B")
        self.assertEqual((remaining["station"], remaining["pack_start_ms"], remaining["dispatch_ms"]), (2, 114000, 117000))
        self.assertEqual(remaining["dispatch"]["boxes"], [{"reservation_id": "B", "shipment_id": "B2", "quantity": 2}])

    def test_snapshot_anchors_the_default_and_earlier_starts_or_closed_windows_fail(self):
        report = replan(self.manifest, {"cutoff_ms": 116000}, self.request)
        self.assertEqual((report["captured_at_ms"], report["start_ms"]), (112000, 112000))
        for window, message in [
            ({"start_ms": 111999, "cutoff_ms": 116000}, "predates"),
            ({"cutoff_ms": 112000}, "cutoff"),
            ({"cutoff_ms": 116000, "holds": []}, "truck window"),
        ]:
            with self.subTest(window=window), self.assertRaisesRegex(ValueError, message):
                replan(self.manifest, window, self.request)

    def test_invalid_manifest_or_failed_snapshot_does_not_use_old_inventory(self):
        window = {"cutoff_ms": 120000}
        self.manifest["work"].append(self.manifest["work"][0])
        with self.assertRaisesRegex(ValueError, "repeated"):
            replan(self.manifest, window, self.request)
        self.assertEqual(self.requests, [])
        self.manifest["work"].pop()
        with self.assertRaisesRegex(ValueError, "HTTP 503"):
            replan(self.manifest, window, lambda path, body: (503, None))
        self.capture["holds"].pop()
        with self.assertRaisesRegex(ValueError, "one Stockroom snapshot per order"):
            replan(self.manifest, window, self.request)
