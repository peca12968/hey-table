from copy import deepcopy
from dataclasses import replace
from itertools import permutations
import json
from pathlib import Path
import random
import unittest

from dispatch import Job, optimize, optimize_parallel, plan


def score(jobs, sequence, start=0):
    at, total = start, 0
    for index in sequence:
        job = jobs[index]
        at = max(at, job.ready) + job.duration
        if at >= job.deadline:
            return None
        total += job.units
    return total, len(sequence), -at if sequence else 0


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

    def test_two_stations_match_independent_exhaustive_splits(self):
        rng = random.Random(219)
        for _ in range(180):
            jobs = [Job(str(i), rng.randrange(8), rng.randrange(1, 6),
                        rng.randrange(4, 17), rng.randrange(1, 12), ())
                    for i in range(rng.randrange(7))]

            def station_score(left, right):
                first, second = score(jobs, left), score(jobs, right)
                if first is not None and second is not None:
                    return first[0] + second[0], first[1] + second[1], min(first[2], second[2])
                return None

            feasible = (station_score(order[:split], order[split:])
                        for length in range(len(jobs) + 1)
                        for order in permutations(range(len(jobs)), length)
                        for split in range(length + 1))
            left, right = optimize_parallel(jobs, 0)
            self.assertEqual(len(set(left + right)), len(left) + len(right))
            self.assertEqual(station_score(left, right), max(s for s in feasible if s is not None), jobs)

    def test_second_station_runs_overlapping_work_without_changing_single_station_format(self):
        single = plan(self.sample)
        report = plan(self.sample, stations=2)
        self.assertEqual(single["ship_units"], 9)
        self.assertNotIn("stations", single)
        self.assertEqual(report["stations"], 2)
        self.assertEqual(report["ship_units"], 10)
        self.assertEqual(report["omitted"], [])
        self.assertEqual([row["reservation_id"] for row in report["scheduled"]], ["A", "B", "C", "D"])
        for station in (1, 2):
            at = self.sample["start_ms"]
            for order in report["scheduled"]:
                if order["station"] == station:
                    self.assertGreaterEqual(order["pack_start_ms"], at)
                    at = order["dispatch_ms"]
                    self.assertLess(at, order["deadline_ms"])
        a, b, *_ = report["scheduled"]
        self.assertNotEqual(a["station"], b["station"])
        self.assertLess(b["pack_start_ms"], a["dispatch_ms"])
        self.sample["work"].reverse()
        self.sample["holds"].reverse()
        self.assertEqual(plan(self.sample, stations=2), report)

    def test_different_station_start_times_match_independent_exhaustive_splits(self):
        rng = random.Random(44219)
        for _ in range(160):
            jobs = [Job(str(i), rng.randrange(10), rng.randrange(1, 5),
                        rng.randrange(3, 17), rng.randrange(1, 10), ())
                    for i in range(rng.randrange(7))]
            starts = rng.randrange(9), rng.randrange(9)

            def station_score(left, right):
                a = score(jobs, left, starts[0])
                b = score(jobs, right, starts[1])
                return None if a is None or b is None else (a[0] + b[0], a[1] + b[1], min(a[2], b[2]))

            brute = (station_score(order[:split], order[split:])
                     for size in range(len(jobs) + 1)
                     for order in permutations(range(len(jobs)), size)
                     for split in range(size + 1))
            left, right = optimize_parallel(jobs, *starts)
            self.assertEqual(len(set(left + right)), len(left) + len(right))
            self.assertEqual(station_score(left, right), max(value for value in brute if value is not None))

    def test_delayed_stations_keep_identity_and_fixture_reproduces(self):
        fixture = json.loads(Path(__file__).with_name("examples").joinpath("parallel-demo.json").read_bytes())
        self.assertEqual(fixture["single"], plan(self.sample))
        self.assertEqual(fixture["parallel"], plan(self.sample, stations=2))
        earlier = 100000
        later = 104000
        for starts, earliest in [([earlier, later], 1), ([later, earlier], 2), ([112000, earlier], 2)]:
            report = plan(dict(self.sample, station_ready_ms=starts), stations=2)
            self.assertEqual(report["station_ready_ms"], starts)
            self.assertEqual(report["ship_units"], 9)
            self.assertEqual(report["omitted"], [{"reservation_id": "A", "reason": "not_selected"}])
            self.assertEqual(report["scheduled"][0]["station"], earliest)
            for order in report["scheduled"]:
                self.assertGreaterEqual(order["pack_start_ms"], starts[order["station"] - 1])
        self.assertEqual(fixture["delayed"], plan(dict(self.sample, station_ready_ms=[earlier, later]), stations=2))

    def test_station_availability_validation_and_deadline(self):
        for invalid in (None, [], [100000], [100000, 99999], [100000, False], "100000"):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "station_ready_ms"):
                plan(dict(self.sample, station_ready_ms=invalid), stations=2)
        report = plan(dict(self.sample, station_ready_ms=[111000, 112000]), stations=2)
        self.assertEqual(report["ship_units"], 0)
        self.assertEqual({row["reason"] for row in report["omitted"]}, {"cannot_finish_before_deadline"})
        single = plan(dict(self.sample, station_ready_ms=[111000]))
        self.assertEqual(single["ship_units"], 0)

    def test_pauses_and_order_eligibility_match_independent_exhaustive_start_search(self):
        rng = random.Random(61103)
        for case in range(300):
            jobs = [Job(str(i), rng.randrange(10), rng.randrange(1, 5),
                        rng.randrange(3, 17), rng.randrange(1, 10), ())
                    for i in range(rng.randrange(6))]
            if case >= 150:
                jobs = [replace(job, allowed_stations=rng.choice(((1,), (2,), (1, 2)))) for job in jobs]
            starts = [rng.randrange(5), rng.randrange(5)]
            pauses = []
            for _station in starts:
                a, b, c, d = sorted(rng.sample(range(16), 4))
                pauses.append(((a, b), (c, d)))

            def station_score(sequence, station):
                at, units = starts[station], 0
                for index in sequence:
                    job = jobs[index]
                    if station + 1 not in job.allowed_stations:
                        return None
                    for begin in range(max(at, job.ready), job.deadline - job.duration):
                        end = begin + job.duration
                        if all(end <= pause_start or begin >= pause_end for pause_start, pause_end in pauses[station]):
                            at, units = end, units + job.units
                            break
                    else:
                        return None
                return units, len(sequence), -at if sequence else 0

            def pair_score(left, right):
                a, b = station_score(left, 0), station_score(right, 1)
                return None if a is None or b is None else (a[0] + b[0], a[1] + b[1], min(a[2], b[2]))

            brute = (pair_score(order[:split], order[split:])
                     for size in range(len(jobs) + 1)
                     for order in permutations(range(len(jobs)), size)
                     for split in range(size + 1))
            left, right = optimize_parallel(jobs, *starts, first_pauses=pauses[0], second_pauses=pauses[1])
            self.assertEqual(len(set(left + right)), len(left) + len(right))
            self.assertEqual(pair_score(left, right), max(value for value in brute if value is not None))

    def test_pause_boundaries_and_merge(self):
        sample = dict(self.sample, work=self.sample["work"][:1], holds=self.sample["holds"][:1])
        intervals = [{"start_ms": 104000, "end_ms": 106000}, {"start_ms": 99000, "end_ms": 100000},
                     {"start_ms": 105000, "end_ms": 107000}, {"start_ms": 107000, "end_ms": 108000}]
        report = plan(dict(sample, station_pauses=[intervals]))
        self.assertEqual(report["station_pauses"], [[{"start_ms": 99000, "end_ms": 100000},
                                                   {"start_ms": 104000, "end_ms": 108000}]])
        self.assertEqual(report["scheduled"][0]["pack_start_ms"], 100000)
        self.assertEqual(report["scheduled"][0]["dispatch_ms"], 104000)
        intervals[1]["end_ms"] = 101000
        self.assertEqual(plan(dict(sample, station_pauses=[intervals]))["omitted"],
                         [{"reservation_id": "A", "reason": "cannot_finish_before_deadline"}])
        for invalid in (None, [], [False], [[{"start_ms": 3, "end_ms": 2}]], [[{"start_ms": False, "end_ms": 1}]]):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "station_pauses|pause"):
                plan(dict(sample, station_pauses=invalid))

    def test_pause_fixture_reassigns_work_and_resume_composes_with_both_constraints(self):
        fixture = json.loads(Path(__file__).with_name("examples").joinpath("parallel-demo.json").read_bytes())
        pause = {"start_ms": 108000, "end_ms": 109000}
        paused = plan(dict(self.sample, station_pauses=[[], [pause]]), stations=2)
        self.assertEqual(fixture["paused"], paused)
        self.assertEqual(paused["ship_units"], 10)
        self.assertEqual(next(order for order in paused["scheduled"] if order["reservation_id"] == "C")["station"], 1)
        self.sample["captured_at_ms"] = 100000
        self.sample["holds"][1]["boxes"] = [{"shipment_id": "B1", "dispatched": 2}]
        self.sample["holds"][1]["reservation"]["held"] = 2
        resumed = plan(dict(self.sample, station_ready_ms=[100000, 101000], station_pauses=[[], [pause]]),
                       stations=2, resume=True)
        self.assertEqual(resumed["ship_units"], 8)
        self.assertEqual(resumed["already_dispatched"][0]["shipment_id"], "B1")
        self.assertNotIn("B1", [box["shipment_id"] for order in resumed["scheduled"] for box in order["dispatch"]["boxes"]])
        for order in resumed["scheduled"]:
            if order["station"] == 2:
                self.assertTrue(order["dispatch_ms"] <= pause["start_ms"] or order["pack_start_ms"] >= pause["end_ms"])

    def test_resume_and_second_station_can_share_the_same_snapshot(self):
        self.sample["captured_at_ms"] = self.sample["start_ms"]
        self.sample["holds"][1]["boxes"] = [{"shipment_id": "B1", "dispatched": 2}]
        self.sample["holds"][1]["reservation"]["held"] = 2
        report = plan(self.sample, stations=2, resume=True)
        self.assertEqual(report["ship_units"], 8)
        self.assertEqual(report["already_dispatched"], [{"reservation_id": "B", "shipment_id": "B1", "quantity": 2}])
        self.assertNotIn("B1", [box["shipment_id"] for job in report["scheduled"] for box in job["dispatch"]["boxes"]])
        for wrong in (0, 3, True, 1.0):
            with self.assertRaises(ValueError):
                plan(self.sample, stations=wrong)

    def test_required_station_is_respected_even_with_identical_station_calendars(self):
        self.sample["work"][0]["allowed_stations"] = [2]
        report = plan(self.sample, stations=2)
        self.assertEqual(report["ship_units"], 10)
        self.assertEqual(report["allowed_stations"], {"A": [2]})
        self.assertEqual(next(row for row in report["scheduled"] if row["reservation_id"] == "A")["station"], 2)
        self.assertEqual(plan(self.sample)["omitted"], [{"reservation_id": "A", "reason": "no_eligible_station"}])
        self.sample["work"][0]["allowed_stations"] = [2, 1]
        self.assertEqual(plan(self.sample, stations=2)["allowed_stations"], {"A": [1, 2]})
        for value in (None, [], [1, 1], [0], [3], [True], ["2"]):
            self.sample["work"][0]["allowed_stations"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "A.allowed_stations"):
                plan(self.sample, stations=2)

    def test_restricted_fixture_and_partial_shipment_keep_required_station(self):
        self.sample["work"][2]["allowed_stations"] = [2]
        self.sample["station_pauses"] = [[], [{"start_ms": 108000, "end_ms": 109000}]]
        report = plan(self.sample, stations=2)
        fixture = json.loads(Path(__file__).with_name("examples").joinpath("parallel-demo.json").read_bytes())
        self.assertEqual(fixture["restricted"], report)
        self.assertEqual(report["ship_units"], 7)
        self.assertEqual(report["omitted"], [{"reservation_id": "C", "reason": "cannot_finish_before_deadline"}])
        self.sample["captured_at_ms"] = 100000
        self.sample["work"][1]["allowed_stations"] = [2]
        self.sample["holds"][1]["boxes"] = [{"shipment_id": "B1", "dispatched": 2}]
        self.sample["holds"][1]["reservation"]["held"] = 2
        resumed = plan(self.sample, stations=2, resume=True)
        self.assertEqual(resumed["ship_units"], 5)
        job = next(row for row in resumed["scheduled"] if row["reservation_id"] == "B")
        self.assertEqual(job["station"], 2)
        self.assertEqual(job["dispatch"]["boxes"], [{"reservation_id": "B", "shipment_id": "B2", "quantity": 2}])
        self.assertEqual(resumed["already_dispatched"], [{"reservation_id": "B", "shipment_id": "B1", "quantity": 2}])

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

    def test_resume_keeps_only_unshipped_boxes_and_subtracts_measured_packing_time(self):
        self.sample["captured_at_ms"] = self.sample["start_ms"]
        self.sample["holds"][1]["boxes"] = [{"shipment_id": "B1", "dispatched": 2, "restocked": 1}]
        self.sample["holds"][1]["reservation"]["held"] = 2
        self.sample["work"][1]["boxes"][0]["pack_ms"] = 2500
        self.sample["work"][1]["boxes"][1]["pack_ms"] = 1500
        self.sample["work"][1]["pack_ms"] = 7000
        result = plan(self.sample, resume=True)
        b = next(row for row in result["scheduled"] if row["reservation_id"] == "B")
        self.assertEqual(b["dispatch_ms"], 106500)
        self.assertEqual(b["dispatch"]["boxes"], [{"reservation_id": "B", "shipment_id": "B2", "quantity": 2}])
        self.assertEqual(result["already_dispatched"], [{"reservation_id": "B", "shipment_id": "B1", "quantity": 2}])
        self.assertEqual(result["shipment_conflicts"], [])
        self.assertEqual(result["ship_units"], 7)
        self.assertNotIn("already_dispatched", plan(self.sample))
        for box in self.sample["work"][1]["boxes"]:
            box.pop("pack_ms")
        omitted = {row["reservation_id"]: row["reason"] for row in plan(self.sample, resume=True)["omitted"]}
        self.assertEqual(omitted["B"], "cannot_finish_before_deadline")

    def test_resume_distinguishes_a_closed_fulfilled_order_and_conflicting_shipment_quantity(self):
        self.sample["captured_at_ms"] = self.sample["start_ms"]
        for index in (0, 3):
            box = self.sample["work"][index]["boxes"][0]
            self.sample["holds"][index]["reservation"].update(state="fulfilled", held=0)
            self.sample["holds"][index]["boxes"] = [
                {"shipment_id": box["shipment_id"], "dispatched": 1},
            ]
        result = plan(self.sample, resume=True)
        self.assertEqual(result["already_dispatched"], [{"reservation_id": "A", "shipment_id": "A1", "quantity": 1}])
        self.assertEqual(result["shipment_conflicts"], [
            {"reservation_id": "D", "shipment_id": "D1", "planned_quantity": 2, "recorded_quantity": 1},
        ])
        omitted = {row["reservation_id"]: row["reason"] for row in result["omitted"]}
        self.assertEqual(omitted, {"A": "already_dispatched", "D": "shipment_quantity_conflict"})

    def test_resume_rejects_missing_snapshot_or_inconsistent_box_packing_times(self):
        with self.assertRaisesRegex(ValueError, "captured_at_ms"):
            plan(self.sample, resume=True)
        self.sample["captured_at_ms"] = self.sample["start_ms"]
        self.sample["work"][1]["boxes"][0]["pack_ms"] = 2500
        with self.assertRaisesRegex(ValueError, "B/B2.pack_ms"):
            plan(self.sample, resume=True)
        self.sample["work"][1]["boxes"][1]["pack_ms"] = 5000
        with self.assertRaisesRegex(ValueError, "exceed"):
            plan(self.sample, resume=True)
