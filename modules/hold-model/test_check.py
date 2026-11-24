from itertools import combinations
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from check import run, validate
from model import generate


ROOT = Path(__file__).resolve().parent
EXAMPLE = ROOT / "examples/partial-expiry.json"


def cli(*args):
    return subprocess.run([sys.executable, ROOT/"check.py", *args], capture_output=True, text=True)


class HoldChecks(unittest.TestCase):
    def test_eight_steps_reduce_to_three_and_replay_against_both_services(self):
        fault = ["--fault", "missed-expiry-credit"]
        response = cli("--trace", EXAMPLE, *fault)
        self.assertEqual(response.returncode, 1, response.stderr)
        case = json.loads(response.stdout)
        self.assertEqual([action["op"] for action in case["actions"]], ["reserve", "ship", "advance"])
        self.assertEqual((case["original_failure"]["step"], case["failure"]["step"]), (8, 3))
        self.assertEqual(case["failure"], dict(step=3, operation="advance", field="inventory.available",
                                              expected=17, actual=12))
        with TemporaryDirectory() as temp:
            path = Path(temp)/"replay.json"
            saved = cli("--trace", EXAMPLE, *fault, "--output", path)
            self.assertEqual(saved.returncode, 1)
            self.assertEqual(json.loads(path.read_bytes()), case)
            replay = cli("--trace", path, *fault)
            self.assertEqual(replay.returncode, 1)
            self.assertEqual(json.loads(replay.stdout)["failure"], case["failure"])
            clean = cli("--trace", path)
            self.assertEqual(clean.returncode, 0, clean.stderr)
            self.assertTrue(json.loads(clean.stdout)["passed"])
        for pair in combinations(case["actions"], 2):
            run(pair, fault="missed-expiry-credit")

    def test_partial_cancel_and_renewal_replays_after_expiry(self):
        hold = {"op": "reserve", "key": "r", "qty": 8}
        ship = {"op": "ship", "key": "r", "qty": 3, "receipt": "k"}
        cut = {**ship, "op": "release", "qty": 2}
        renew = {"op": "renew", "key": "r", "receipt": "k", "expected": 105000, "seconds": 3}
        coverage = run([hold, ship, cut, renew, {**renew, "receipt": "other"}, {"op": "advance", "seconds": 5},
                        {"op": "restart"}, {"op": "advance", "seconds": 3}, hold, cut, ship, renew])
        for op in ("reserve", "ship", "release", "renew"):
            self.assertEqual((coverage[f"{op}/201"], coverage[f"{op}/200"]), (1, 1))
        self.assertEqual(coverage["renew/409"], 1)

    def test_seeded_campaign_and_checked_trace_schema(self):
        self.assertEqual(generate(27, 40), generate(27, 40))
        result = cli("--seed", "1", "--runs", "8", "--steps", "32")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual((data["cases"], data["steps"]), (8, 256))
        for op in ["reserve/201", "ship/201", "release/201", "renew/201", "advance", "restart", "cancel/200"]:
            self.assertGreater(data["coverage"][op], 0)
        for trace in [[{"op":"advance","seconds":-1}], [{"op":"cancel","key":"a/b"}],
                      [{"op":"reserve","qty":True,"key":"r"}], {"op":"restart"}]:
            with self.assertRaises(ValueError):
                validate(trace)


if __name__ == "__main__":
    unittest.main()
