from copy import deepcopy
import json
from pathlib import Path
import unittest

from audit import audit
from dispatch import plan


def recorded(reservation, shipment, units, restocked=0):
    return {"reservation_id": reservation, "shipment_id": shipment, "dispatched": units, "restocked": restocked}


class AuditTests(unittest.TestCase):
    def setUp(self):
        document = json.loads(Path(__file__).with_name("examples").joinpath("morning.json").read_bytes())
        self.first = plan(document)
        self.second = dict(deepcopy(self.first), ship_units=2)
        self.second["scheduled"] = self.second["scheduled"][-1:]
        self.shipments = {
            "B": [recorded("B", "B1", 2, restocked=1), recorded("B", "B2", 2)],
            "C": [recorded("C", "C1", 3)],
            "D": [],
        }
        self.calls = []

    def request(self, path, body):
        self.calls.append((path, body))
        holds = [{"reservation": {"id": reservation, "state": "fulfilled" if self.shipments[reservation] else "held"},
                  "boxes": self.shipments[reservation]} for reservation in body["reservation_ids"]]
        return 200, {"captured_at_ms": 112000, "holds": holds}

    def test_overlapping_trucks_count_each_box_once_and_preserve_gross_shipments_with_returns(self):
        result = audit([self.first, self.second], self.request)
        self.assertEqual(self.calls, [("/packing-snapshots", {"reservation_ids": ["B", "C", "D"]})])
        self.assertEqual(result["captured_at_ms"], 112000)
        self.assertEqual((result["confirmed_units"], result["pending_units"], result["conflicting_boxes"]), (7, 2, 0))
        self.assertEqual((result["boxes"][0]["recorded_units"], result["boxes"][0]["restocked_units"]), (2, 1))
        self.assertEqual(result["boxes"][-1], {
            "reservation_id": "D", "shipment_id": "D1", "plans": [{"plan": 1, "quantity": 2}, {"plan": 2, "quantity": 2}],
            "recorded_units": None, "restocked_units": None, "reservation_state": "held", "status": "pending",
        })
        self.shipments["D"].append(recorded("D", "D1", 2))
        after = audit([self.first, self.second], self.request)
        self.assertEqual((after["confirmed_units"], after["pending_units"], after["conflicting_boxes"]), (9, 0, 0))
        self.assertEqual(after["boxes"][-1]["status"], "confirmed")

    def test_disagreeing_plans_and_stockroom_mismatch_are_separate(self):
        changed = self.second["scheduled"][0]
        self.second["ship_units"] = changed["units"] = changed["dispatch"]["boxes"][0]["quantity"] = 1
        self.shipments["D"].append(recorded("D", "D1", 2))
        both = audit([self.first, self.second], self.request)
        self.assertEqual((both["confirmed_units"], both["conflicting_boxes"]), (7, 1))
        row = both["boxes"][-1]
        self.assertEqual(row["status"], "plan_conflict")
        self.assertEqual(row["recorded_units"], 2)
        self.assertEqual(row["plans"], [{"plan": 1, "quantity": 2}, {"plan": 2, "quantity": 1}])
        single = audit([self.second], self.request)
        self.assertEqual((single["confirmed_units"], single["pending_units"], single["conflicting_boxes"]), (0, 0, 1))
        self.assertEqual(single["boxes"][0]["status"], "quantity_conflict")

    def test_bad_plan_and_incomplete_or_inconsistent_snapshot_cannot_pass_as_pending(self):
        damaged = dict(self.second, ship_units=12)
        with self.assertRaisesRegex(ValueError, "shipment total"):
            audit([self.first, damaged], self.request)
        self.assertEqual(self.calls, [])
        empty = dict(self.first, ship_units=0, scheduled=[])
        self.assertEqual(audit([empty], self.request)["captured_at_ms"], None)
        self.assertEqual(self.calls, [])
        for response, message in [
            ((503, None), "HTTP 503"),
            ((200, {"captured_at_ms": 112000, "holds": []}), "does not cover"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                audit([self.first], lambda *_: response)
        self.shipments["D"] = [recorded("C", "D1", 2)]
        with self.assertRaisesRegex(ValueError, "another reservation"):
            audit([self.first], self.request)
