"""Black-box route checks including an independent whole-grid search."""
from collections import deque
import json
from pathlib import Path
import random
import subprocess
import sys
import unittest

EXAMPLE = Path(__file__).resolve().parent / "examples/aisles.txt"


def reference(rows):
    # Search the entire (cell, collected items) graph directly, without a distance matrix.
    bits = {}
    for r, row in enumerate(rows):
        for c, tile in enumerate(row):
            if tile == "D":
                depot = (r, c)
            elif tile == "*":
                bits[r, c] = 1 << len(bits)
    all_items = (1 << len(bits)) - 1
    pending = deque([(depot, 0, 0)])
    seen = {(depot, 0)}
    while pending:
        (r, c), items, steps = pending.popleft()
        if (r, c) == depot and items == all_items:
            return steps
        for nr, nc in [(r + 1, c), (r - 1, c), (r, c - 1), (r, c + 1)]:
            if not (0 <= nr < len(rows) and 0 <= nc < len(rows[0])) or rows[nr][nc] == "#":
                continue
            state = ((nr, nc), items | bits.get((nr, nc), 0))
            if state not in seen:
                seen.add(state)
                pending.append((*state, steps + 1))
    return None


class RouteTests(unittest.TestCase):
    def cli(self, *args, data=""):
        return subprocess.run([EXE, *args], input=data, capture_output=True, text=True, timeout=10)

    def check_walk(self, rows, plan):
        walk = [tuple(p) for p in plan["walk"]]
        self.assertEqual(len(walk), plan["steps"] + 1)
        self.assertEqual(walk[0], walk[-1])
        self.assertEqual(rows[walk[0][0] - 1][walk[0][1] - 1], "D")
        picks = []
        for i, (r, c) in enumerate(walk):
            self.assertTrue(1 <= r <= len(rows) and 1 <= c <= len(rows[0]))
            self.assertNotEqual(rows[r - 1][c - 1], "#")
            if i:
                self.assertEqual(abs(r - walk[i - 1][0]) + abs(c - walk[i - 1][1]), 1)
            if rows[r - 1][c - 1] == "*" and [r, c] not in picks:
                picks.append([r, c])
        self.assertEqual(picks, plan["pick_order"])
        self.assertEqual(len(picks), sum(row.count("*") for row in rows))

    def test_example_exact_and_nearest(self):
        rows = EXAMPLE.read_text().splitlines()
        for options, method, steps in [([], "exact", 30), (["--nearest"], "nearest", 42)]:
            result = self.cli(*options, EXAMPLE)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual((plan["method"], plan["steps"]), (method, steps))
            self.check_walk(rows, plan)
        self.assertEqual(reference(rows), 30)

    def test_random_floors_against_full_grid_reference(self):
        rng = random.Random(9281)
        reachable = unreachable = 0
        for i in range(60):
            h, w = rng.randint(3, 6), rng.randint(3, 6)
            cells = ["#" if rng.random() < .25 else "." for _ in range(h * w)]
            locations = rng.sample(range(h * w), 1 + rng.randint(1, 5))
            cells[locations[0]] = "D"
            for cell in locations[1:]:
                cells[cell] = "*"
            rows = ["".join(cells[j:j + w]) for j in range(0, len(cells), w)]
            expected = reference(rows)
            with self.subTest(i=i, rows=rows):
                result = self.cli("-", data="\n".join(rows))
                if expected is None:
                    unreachable += 1
                    self.assertEqual((result.returncode, result.stdout), (2, ""))
                    self.assertIn("unreachable pick", result.stderr)
                else:
                    reachable += 1
                    self.assertEqual(result.returncode, 0, result.stderr)
                    plan = json.loads(result.stdout)
                    self.assertEqual(plan["steps"], expected)
                    self.check_walk(rows, plan)
        self.assertGreater(reachable, 0)
        self.assertGreater(unreachable, 0)

    def test_empty_order_detour_and_crlf_input(self):
        for rows, expected in [(["D"], 0), (["D#*", "..."], 8), (["**D**"], 8)]:
            result = self.cli(data="\r\n".join(rows))
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(plan["steps"], expected)
            self.check_walk(rows, plan)

    def test_exact_limit_and_explicit_large_order_mode(self):
        for count, options in [(14, []), (15, ["--nearest"]), (64, ["--nearest"])]:
            floor = "D" + "*" * count
            result = self.cli(*options, data=floor)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.check_walk([floor], plan)
            self.assertEqual(plan["steps"], count * 2)
        for count, options in [(15, []), (65, ["--nearest"])]:
            result = self.cli(*options, data="D" + "*" * count)
            self.assertEqual((result.returncode, result.stdout), (2, ""))
            self.assertIn("too many picks", result.stderr)

    def test_invalid_floors_and_unreachable_picks(self):
        for floor in ["", "...", "DD", "D\n..", "D?", "D#*", "D.\n\n", "D" + "." * 128,
                      "D\n" + ".\n" * 128]:
            with self.subTest(floor=floor):
                result = self.cli(data=floor)
                self.assertEqual((result.returncode, result.stdout), (2, ""))
                self.assertTrue(result.stderr)


if __name__ == "__main__":
    EXE = sys.argv.pop(1)
    unittest.main(verbosity=2)
