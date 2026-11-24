import itertools
import json
from pathlib import Path
import unittest

from example import lunch
from ready import report


EXAMPLE = Path(__file__).parent / "examples" / "lunch-receipts.json"


def receipt(key, method="line_pay", env="demo"):
    return dict(id=key, created=90000, mode="pickup" if key % 2 else "table",
                paymentMethod=method, paymentEnv=env)


class ReceiptGroupsTests(unittest.TestCase):
    def test_lunch_coverage_bounds_and_minimal_output(self):
        rows = json.loads(EXAMPLE.read_text())
        copies = [{**row, "note":"private-note", "paymentState":"unpaid"} for row in reversed(rows)]
        data = report(lunch(), 40, receipts=[rows, copies, {**rows[0], "paymentState":"paid"}])
        self.assertNotIn("private-note", json.dumps(data))
        self.assertNotIn("paymentState", json.dumps(data))
        coverage = data["paymentBreakdown"]
        self.assertEqual((coverage["matched"], coverage["missing"], coverage["receiptOnly"]), (4,1,0))
        groups = {g["method"]:g for g in coverage["groups"]}
        self.assertEqual(groups["line_pay"]["counts"], dict(on_time=1, missed=1, uncertain=0))
        self.assertEqual(groups["line_pay"]["percentileMs"], dict(p50=[0,40000], p90=[70000,None]))
        self.assertEqual(groups["px_pay_plus"]["onTimeCountRange"], [0,1])
        self.assertEqual(groups["cash"]["onTimeCountRange"], [0,0])
        self.assertEqual(groups[None]["onTimeCountRange"], [0,1])
        self.assertEqual(data["onTimeCountRange"], [1,3])
        self.assertNotIn("paymentBreakdown", report(lunch(), 40))

    def test_every_receipt_subset_partitions_the_same_five_tickets(self):
        for present in itertools.product([False,True], repeat=5):
            docs = [receipt(i) for i, keep in enumerate(present, 1) if keep]
            for mode in (None, "pickup", "table"):
                baseline = report(lunch(), 40, mode)
                data = report(lunch(), 40, mode, [docs])
                coverage = data["paymentBreakdown"]
                known = sum(present[row["id"]-1] for row in baseline["orders"])
                self.assertEqual(coverage["matched"], known)
                self.assertEqual(coverage["missing"], baseline["observed"]-known)
                self.assertEqual(coverage["receiptOnly"], 0)
                for outcome, expected in baseline["counts"].items():
                    self.assertEqual(sum(g["counts"][outcome] for g in coverage["groups"]), expected)
                self.assertEqual(data["percentileMs"], baseline["percentileMs"])

    def test_separate_environments_unobserved_receipts_and_filtered_modes(self):
        docs = [receipt(1),receipt(3,env="production"),receipt(2,env="sandbox"),receipt(7),receipt(8)]
        coverage = report(lunch(), 40, receipts=docs)["paymentBreakdown"]
        self.assertEqual(coverage["receiptOnly"], 2)
        self.assertEqual({g["environment"] for g in coverage["groups"]}, {None,"demo","sandbox","production"})
        coverage = report(lunch(), 40, "table", [docs, receipt(8)])["paymentBreakdown"]
        self.assertEqual((coverage["matched"],coverage["missing"],coverage["receiptOnly"]), (1,1,1))

    def test_conflicting_identity_rejected_even_outside_mode_filter(self):
        for change in [dict(mode="table"),dict(created=1),dict(paymentMethod="card"),dict(paymentEnv="production")]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                report(lunch(), 40, "table", [receipt(1),{**receipt(1),**change}])
        for change in [dict(id=True),dict(created=True),dict(paymentMethod=[]),dict(paymentEnv="cash"),
                       dict(paymentMethod="cash"),dict(mode="table"),dict(created=1)]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                report(lunch(), 40, receipts=[{**receipt(1),**change}])
