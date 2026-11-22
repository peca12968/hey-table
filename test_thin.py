from fractions import Fraction
from itertools import combinations
import json
from pathlib import Path
import random
import unittest

from thin import simplify


def error(fixes, kept):
    largest = Fraction(0)
    for left, right in zip(kept, kept[1:]):
        a, b = fixes[left], fixes[right]
        for p in fixes[left + 1:right]:
            weight = Fraction(p["t_ms"] - a["t_ms"], b["t_ms"] - a["t_ms"])
            for field in ("x_mm", "y_mm"):
                estimate = a[field] * (1 - weight) + b[field] * weight
                largest = max(largest, abs(estimate - p[field]))
    return largest


class TrackTests(unittest.TestCase):
    def test_loading_bay_wait_and_door_event(self):
        fixes = json.loads((Path(__file__).parent / "examples/loading-bay.json").read_text())
        r = simplify(fixes, 750)
        self.assertEqual(r["segments"][0]["kept_indices"], [0, 3, 5, 6, 10])
        self.assertEqual(r["segments"][0]["fixes"][2]["event"], "door opened")
        self.assertEqual(r["max_axis_error_mm"], {"numerator": 750, "denominator": 1})

    def test_small_paths_against_every_subset(self):
        rng = random.Random(417)
        for _ in range(120):
            n, tol = rng.randrange(2, 10), rng.randrange(0, 9)
            fixes = []
            t = 10**18
            for i in range(n):
                t += rng.randrange(1, 6)
                fixes.append({"t_ms": t, "x_mm": 10**18 + rng.randrange(13), "y_mm": -rng.randrange(13),
                              "keep": rng.randrange(7) == 0})
            r = simplify(fixes, tol)
            kept = r["segments"][0]["kept_indices"]
            mandatory = {i for i, p in enumerate(fixes) if p["keep"]}
            self.assertTrue(mandatory <= set(kept))
            self.assertLessEqual(error(fixes, kept), tol)
            self.assertEqual(error(fixes, kept), Fraction(**r["max_axis_error_mm"]))
            for size in range(2, len(kept)):
                for middle in combinations(range(1, n-1), size-2):
                    trial = (0, *middle, n-1)
                    if mandatory <= set(trial):
                        self.assertGreater(error(fixes, trial), tol)

    def test_outages_split_segments_and_keep_isolated_fixes(self):
        fixes = [{"t_ms": t, "x_mm": t, "y_mm": 0} for t in [0, 10, 20, 31, 42, 52]]
        r = simplify(fixes, 0, split_gap_ms=10)
        self.assertEqual([s["kept_indices"] for s in r["segments"]], [[0, 2], [3], [4, 5]])
        self.assertEqual(r["kept_count"], 5)
        self.assertEqual(simplify(fixes, 0)["kept_count"], 2)
