from copy import deepcopy
from itertools import permutations
import json
from pathlib import Path
import random
import unittest

from dispatch import Job, optimize, plan


def score(jobs, sequence):
    at = total = 0
    for index in sequence:
        job = jobs[index]
        at = max(at, job.ready) + job.duration
        if at >= job.deadline:
            return None
        total += job.units
    return total, len(sequence), -at


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.sample = json.loads(
            Path(__file__).with_name("examples").joinpath("morning.json").read_bytes()
        )

    def test_300_random_instances_against_exhaustive_sequences(self):
        rng = random.Random(834)
        for _ in range(300):
            jobs = [
                Job(
                    str(i),
                    rng.randrange(9),
                    rng.randrange(1, 6),
                    rng.randrange(4, 20),
                    rng.randrange(1, 12),
                    (),
                )
                for i in range(rng.randrange(7))
            ]
            feasible = [
                score(jobs, orders)
                for length in range(len(jobs) + 1)
                for orders in permutations(range(len(jobs)), length)
            ]
            self.assertEqual(
                score(jobs, optimize(jobs, 0)),
                max(s for s in feasible if s is not None),
                jobs,
            )

    def test_example_prefers_waiting_for_more_units_and_has_stable_order(self):
        result = plan(self.sample)
        self.assertEqual(result["ship_units"], 9)
        self.assertEqual(
            [
                (job["reservation_id"], job["pack_start_ms"], job["dispatch_ms"])
                for job in result["scheduled"]
            ],
            [("B", 102000, 107000), ("C", 107000, 109000), ("D", 109000, 110000)],
        )
        self.assertEqual(
            result["omitted"], [{"reservation_id": "A", "reason": "not_selected"}]
        )
        self.sample["work"].reverse()
        self.sample["holds"].reverse()
        self.sample["work"][2]["boxes"].reverse()
        self.assertEqual(plan(self.sample), result)

    def test_exact_expiry_and_truck_cutoff_are_both_exclusive(self):
        self.sample["work"][1]["pack_ms"] = 6000
        self.sample["cutoff_ms"] = 110000
        result = plan(self.sample)
        omitted = {row["reservation_id"]: row["reason"] for row in result["omitted"]}
        self.assertEqual(
            omitted,
            {
                "B": "cannot_finish_before_deadline",
                "D": "cannot_finish_before_deadline",
            },
        )
        self.sample["work"][1]["pack_ms"] -= 1
        self.sample["cutoff_ms"] = 111000
        self.assertEqual(plan(self.sample)["ship_units"], 9)

    def test_old_shipment_id_insufficient_hold_and_closed_orders_are_distinguished(
        self,
    ):
        self.sample["holds"][0]["reservation"]["state"] = "expired"
        self.sample["holds"][1]["boxes"] = [{"shipment_id": "B1"}]
        self.sample["holds"][2]["reservation"]["held"] = 2
        result = plan(self.sample)
        self.assertEqual(result["ship_units"], 2)
        self.assertEqual(
            [row["reason"] for row in result["omitted"]],
            ["hold_closed", "shipment_id_already_used", "insufficient_hold"],
        )

    def test_invalid_duplicate_and_unjoined_rows_are_rejected(self):
        for edit in [
            lambda x: x["holds"].pop(),
            lambda x: x["work"].append(x["work"][0]),
            lambda x: x["work"][0]["boxes"].extend(x["work"][0]["boxes"]),
            lambda x: x["work"][0].update(pack_ms=True),
            lambda x: x["work"][0]["boxes"][0].update(quantity=1000001),
            lambda x: x.update(start_ms=111001),
            lambda x: x.update(captured_at_ms=x["start_ms"] + 1),
        ]:
            document = deepcopy(self.sample)
            edit(document)
            with self.assertRaises(ValueError):
                plan(document)

    def test_snapshot_timestamp_at_or_before_planned_start(self):
        for captured in (self.sample["start_ms"] - 1, self.sample["start_ms"]):
            document = dict(self.sample, captured_at_ms=captured)
            self.assertEqual(plan(document), plan(self.sample))
