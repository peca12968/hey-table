from copy import deepcopy
import itertools
import json
from pathlib import Path
import random
import unittest

from history import capture, expected_response, verify
from model import Model


class HistoryTests(unittest.TestCase):
    def test_live_two_instance_histories_have_witnesses(self):
        for name in ("last-units", "packing", "renew"):
            for _ in range(5):
                with self.subTest(scenario=name):
                    calls = capture(name)
                    self.assertEqual({r["instance"] for r in calls}, {0, 1})
                    result = verify(list(reversed(calls)))
                    self.assertEqual(result["verdict"], "linearizable", calls)
                    indexed = {r["start"]: r for r in calls}
                    ordered = [indexed[t] for t in result["order"]]
                    self.assertEqual(len(set(result["order"])), len(calls))
                    model = Model()
                    for pos, row in enumerate(ordered):
                        self.assertTrue(all(other["end"] > row["start"] for other in ordered[pos+1:]))
                        status, body = expected_response(model, row["action"])
                        self.assertEqual(status, row["status"])
                        if body is not None:
                            self.assertEqual(body, row["body"])

    def test_read_depends_on_real_time_order_and_search_budget(self):
        reserve = {"op": "reserve", "key": "r", "qty": 13}
        model = Model()
        first = {"start": 1, "end": 2, "action": reserve, "status": 201, "body": model.apply(reserve)[1]}
        read = {"start": 3, "end": 4, "action": {"op":"inventory"}, "status": 200, "body": [Model().stock()]}
        self.assertEqual(verify([first, read])["verdict"], "impossible")
        first["end"] = 5
        self.assertEqual(verify([first, read], limit=1)["verdict"], "inconclusive")
        self.assertEqual(verify([first, read])["order"], [3, 1])
        read["body"][0]["available"] = True
        self.assertEqual(verify([read, first])["verdict"], "impossible")
        read["start"] = first["start"]
        with self.assertRaises(ValueError):
            verify([first, read])

    def test_impossible_double_success_and_wrong_receipt(self):
        source = Path(__file__).parent / "examples/double-reserve.json"
        calls = json.loads(source.read_bytes())["calls"]
        rejected = verify(calls)
        self.assertEqual(rejected["verdict"], "impossible")
        blocked, = rejected["blocked_next"]
        self.assertEqual((blocked["start"], blocked["expected_status"], blocked["observed_status"]), (2, 409, 201))
        calls[1].update(status=409, body={"detail": "Insufficient stock"})
        self.assertEqual(verify(calls)["order"], [1, 2])
        calls[0]["body"]["quantity"] = 12
        self.assertEqual(verify(calls)["verdict"], "impossible")

    def test_160_generated_histories_against_all_permutations(self):
        rng = random.Random(721)
        for case in range(160):
            model = Model()
            events = list(range(1, 9))
            rng.shuffle(events)
            calls = []
            for i in range(4):
                key = rng.choice(["a","b"])
                action = rng.choice([{"op":"reserve","key":key,"qty":13}, {"op":"inventory"},
                                     {"op":"cancel","key":key}, {"op":"progress","key":key}])
                start, end = sorted(events[2*i:2*i+2])
                status, body = expected_response(model, action)
                calls.append(dict(start=start, end=end, action=action, status=status, body=deepcopy(body)))
            if case % 4 == 0:
                rng.choice(calls)["status"] = 500
            legal = False
            for order in itertools.permutations(calls):
                if any(earlier["start"] > later["end"] for earlier, later in itertools.combinations(order, 2)):
                    continue
                other = Model()
                for row in order:
                    status, body = expected_response(other, row["action"])
                    if status != row["status"] or (body is not None and body != row["body"]):
                        break
                else:
                    legal = True
                    break
            self.assertEqual(verify(calls)["verdict"], "linearizable" if legal else "impossible", case)
