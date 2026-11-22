"""Black-box route checks including an independent whole-grid search."""
from collections import deque
from heapq import heappop, heappush
import json
from pathlib import Path
import random
import subprocess
import sys
import unittest

EXAMPLE = Path(__file__).resolve().parent / "examples/aisles.txt"
WEIGHTED = EXAMPLE.with_name("weighted-aisles.txt")


def weight(tile):
    if tile == "*":
        return 1
    return int(tile) if tile in "123456789" else 0


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


def cart_reference(rows, capacity=None, max_load=None):
    # Walk one cell, pick up one item or unload at the depot. Search the actual
    # state space, minimizing (steps, unloads), independently of subset tours.
    tiles = {(r, c): tile for r, row in enumerate(rows) for c, tile in enumerate(row) if tile != "#"}
    depot = next(cell for cell, tile in tiles.items() if tile == "D")
    bits = {cell: 1 << i for i, cell in enumerate(cell for cell in tiles if weight(tiles[cell]))}
    goal = (1 << len(bits)) - 1
    initial = (depot, 0, 0)
    best = {initial: (0, 0)}
    queue = [(0, 0, initial)]
    while queue:
        steps, trips, state = heappop(queue)
        if best[state] != (steps, trips):
            continue
        cell, picked, onboard = state
        if cell == depot and picked == goal and not onboard:
            return steps, trips
        r, c = cell
        options = [(steps + 1, trips, (neighbor, picked, onboard))
                   for neighbor in ((r-1, c), (r+1, c), (r, c-1), (r, c+1)) if neighbor in tiles]
        bit = bits.get(cell, 0)
        if bit and not (bit & picked):
            cargo = onboard | bit
            weights = [weight(tiles[location]) for location, item in bits.items() if cargo & item]
            if (capacity is None or len(weights) <= capacity) and (max_load is None or sum(weights) <= max_load):
                options.append((steps, trips, (cell, picked | bit, cargo)))
        if cell == depot and onboard:
            options.append((steps, trips + 1, (depot, picked, 0)))
        for new_steps, new_trips, target in options:
            score = (new_steps, new_trips)
            if target not in best or score < best[target]:
                best[target] = score
                heappush(queue, (new_steps, new_trips, target))
    return None


class RouteTests(unittest.TestCase):
    def cli(self, *args, data=""):
        return subprocess.run([EXE, *args], input=data, capture_output=True, text=True, timeout=10)

    def check_walk(self, rows, plan, assigned=None):
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
            if weight(rows[r - 1][c - 1]) and [r, c] not in picks and (assigned is None or (r, c) in assigned):
                picks.append([r, c])
        self.assertEqual(picks, plan["pick_order"])
        self.assertEqual(len(picks), sum(bool(weight(t)) for row in rows for t in row) if assigned is None else len(assigned))

    def check_cart(self, rows, plan, capacity=None, max_load=None):
        self.assertEqual(plan.get("capacity"), capacity)
        self.assertEqual(plan.get("max_load"), max_load)
        picks = []
        walk = [plan["walk"][0]]
        self.assertEqual(rows[walk[0][0] - 1][walk[0][1] - 1], "D")
        for trip in plan["trips"]:
            assigned = set(map(tuple, trip["pick_order"]))
            self.assertTrue(assigned)
            if capacity is not None:
                self.assertLessEqual(len(assigned), capacity)
            if max_load is not None:
                self.assertEqual(trip["load"], sum(weight(rows[r-1][c-1]) for r, c in assigned))
                self.assertLessEqual(trip["load"], max_load)
            else:
                self.assertNotIn("load", trip)
            self.check_walk(rows, trip, assigned)
            self.assertEqual(trip["walk"][0], walk[-1])
            walk.extend(trip["walk"][1:])
            picks.extend(trip["pick_order"])
        expected = {(r, c) for r, row in enumerate(rows, 1) for c, tile in enumerate(row, 1) if weight(tile)}
        self.assertEqual(set(map(tuple, picks)), expected)
        self.assertEqual(len(picks), len(expected))
        self.assertEqual((plan["pick_order"], plan["walk"], plan["steps"]), (picks, walk, len(walk) - 1))

    def test_capacity_example_and_legacy_route(self):
        rows = EXAMPLE.read_text().splitlines()
        for capacity, options, steps, count in [(1, [], 84, 5), (2, [], 56, 3), (3, [], 42, 2),
                                                (5, [], 30, 1), (2, ["--nearest"], 64, 3)]:
            result = self.cli("--capacity", str(capacity), *options, EXAMPLE)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.check_cart(rows, plan, capacity)
            self.assertEqual((plan["steps"], len(plan["trips"])), (steps, count))
        for options in ([], ["--nearest"]):
            legacy = json.loads(self.cli(*options, EXAMPLE).stdout)
            roomy = json.loads(self.cli(*options, "--capacity", "100", EXAMPLE).stdout)
            self.assertEqual(legacy, {k: v for k, v in roomy.items() if k not in ("capacity", "trips")})

    def test_capacity_against_independent_cart_search(self):
        rng = random.Random(43397)
        floors = [["D"], ["**D**"], ["D#*"], ["D****"]]
        for _ in range(24):
            cells = ["." if rng.random() > .2 else "#" for _ in range(16)]
            depot, *stops = rng.sample(range(16), rng.randint(2, 6))
            cells[depot] = "D"
            for stop in stops:
                cells[stop] = "*"
            floors.append(["".join(cells[i:i + 4]) for i in range(0, 16, 4)])
        for rows in floors:
            for capacity in (1, 2, 3):
                with self.subTest(rows=rows, capacity=capacity):
                    expected = cart_reference(rows, capacity)
                    result = self.cli("--capacity", str(capacity), "-", data="\n".join(rows))
                    if expected is None:
                        self.assertEqual((result.returncode, result.stdout), (2, ""))
                        self.assertIn("unreachable", result.stderr)
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        plan = json.loads(result.stdout)
                        self.check_cart(rows, plan, capacity)
                        self.assertEqual((plan["steps"], len(plan["trips"])), expected)

    def test_weighted_example_separates_both_constraints(self):
        rows = WEIGHTED.read_text().splitlines()
        for slots, limit, nearest, expected in [(None, 8, False, (52, 2)), (2, None, False, (56, 3)),
                                                (2, 8, False, (58, 3)), (2, 8, True, (64, 3))]:
            args = (["--capacity", str(slots)] if slots else []) + (["--max-load", str(limit)] if limit else [])
            result = self.cli(*args, *(["--nearest"] if nearest else []), WEIGHTED)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.check_cart(rows, plan, slots, limit)
            self.assertEqual((plan["steps"], len(plan["trips"])), expected)
            if not nearest:
                self.assertEqual(cart_reference(rows, slots, limit), expected)
        unlimited = json.loads(self.cli(WEIGHTED).stdout)
        self.assertEqual(unlimited, json.loads(self.cli(EXAMPLE).stdout))

    def test_weighted_floors_against_grid_search_and_check_nearest_walks(self):
        rng = random.Random(779)
        floors = [["D"], ["D#9"], ["D3*21"], ["2*D*2"]]
        for _ in range(20):
            tiles = ["#" if rng.random() < 0.17 else "." for _ in range(12)]
            depot, *stops = rng.sample(range(12), rng.randint(3, 6))
            tiles[depot] = "D"
            for stop in stops:
                tiles[stop] = rng.choice("*12345")
            floors.append(["".join(tiles[i:i+4]) for i in (0, 4, 8)])
        for rows in floors:
            for slots, limit in [(None, 5), (2, 5), (3, 7)]:
                args = ["--max-load", str(limit)] + (["--capacity", str(slots)] if slots else [])
                expected = cart_reference(rows, slots, limit)
                for nearest in [False, True]:
                    with self.subTest(rows=rows, slots=slots, limit=limit, nearest=nearest):
                        result = self.cli(*args, *(["--nearest"] if nearest else []), data="\n".join(rows))
                        if expected is None:
                            self.assertEqual((result.returncode, result.stdout), (2, ""))
                        else:
                            self.assertEqual(result.returncode, 0, result.stderr)
                            plan = json.loads(result.stdout)
                            self.check_cart(rows, plan, slots, limit)
                            score = (plan["steps"], len(plan["trips"]))
                            if nearest:
                                self.assertGreaterEqual(score, expected)
                            else:
                                self.assertEqual(score, expected)

    def test_load_limit_boundary_and_overweight_item(self):
        result = self.cli("--nearest", "--max-load", "5", data="D332")
        plan = json.loads(result.stdout)
        self.check_cart(["D332"], plan, max_load=5)
        self.assertEqual(plan["trips"][0]["pick_order"], [[1, 2], [1, 4]])
        for options in [[], ["--nearest"]]:
            result = self.cli(*options, "--max-load", "8", data="D*9")
            self.assertEqual((result.returncode, result.stdout), (2, ""))
            self.assertIn("row 1, column 3", result.stderr)
            for value in ["0", "-1", "1.5", "2147483648", ""]:
                self.assertEqual(self.cli(*options, "--max-load", value, data="D*").returncode, 2)
            count = 64 if options else 14
            rows = ["D" + "9" * count]
            result = self.cli(*options, "--max-load", "2147483647", data=rows[0])
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.check_cart(rows, plan, max_load=2147483647)
            self.assertEqual([t["load"] for t in plan["trips"]], [9*count])

    def test_capacity_bounds(self):
        for invalid in ["0", "-1", "2.5", "999999999999999999999", "x", ""]:
            result = self.cli("--capacity", invalid, data="D*")
            self.assertEqual((result.returncode, result.stdout), (2, ""))
        for n, options in [(14, []), (64, ["--nearest"])]:
            rows = ["D" + "*" * n]
            result = self.cli(*options, "--capacity", "1", data=rows[0])
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.check_cart(rows, plan, 1)
            self.assertEqual(plan["steps"], n * (n + 1))

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

    def test_closure_combinations_against_grid_search(self):
        rows = EXAMPLE.with_name("maintenance.txt").read_text().splitlines()
        locations = [(1, 3), (3, 3), (1, 5), (1, 6), (2, 8), (3, 1)]
        open_cells = {(r, c) for r, row in enumerate(rows, 1) for c, tile in enumerate(row, 1) if tile != "#"}
        picks = {p for p in open_cells if weight(rows[p[0]-1][p[1]-1])}
        for mask in range(1 << len(locations)):
            closed = {cell for i, cell in enumerate(locations) if mask & (1 << i)}
            available = open_cells - closed
            reached = {(1, 1)}
            while True:
                neighbors = {(r+dr, c+dc) for r, c in reached for dr, dc in ((0, 1), (0, -1), (1, 0), (-1, 0))}
                more = (neighbors & available) - reached
                if not more:
                    break
                reached.update(more)
            effective = ["".join(tile if (r, c) in reached else "#" for c, tile in enumerate(row, 1))
                         for r, row in enumerate(rows, 1)]
            expected = cart_reference(effective, capacity=2, max_load=5)
            args = [v for r, c in sorted(closed) for v in ("--close", str(r), str(c))]
            for method in ([], ["--nearest"]):
                with self.subTest(closed=closed, method=method):
                    result = self.cli("--reachable-only", *args, *method, "--capacity", "2", "--max-load", "5",
                                      data="\n".join(rows))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    plan = json.loads(result.stdout)
                    self.assertEqual(plan["complete"], picks <= reached)
                    self.assertEqual(plan["unreachable"], list(map(list, sorted(picks - reached))))
                    self.check_cart(effective, plan, 2, 5)
                    if not method:
                        self.assertEqual((plan["steps"], len(plan["trips"])), expected)

    def test_invalid_closures_partial_order_limits_and_strict_output(self):
        for args in (["--close", "1", "1"], ["--close", "0", "2"], ["--close", "1", "4"], ["--close", "1"]):
            result = self.cli(*args, data="D.*")
            self.assertEqual((result.returncode, result.stdout), (2, ""))
        strict = self.cli("--close", "1", "2", data="D.*")
        self.assertEqual((strict.returncode, strict.stdout), (2, ""))
        self.assertIn("unreachable pick at row 1, column 3", strict.stderr)
        partial = self.cli("--reachable-only", "--close", "1", "2", "--close", "1", "2",
                           data="D." + "*" * 16)
        plan = json.loads(partial.stdout)
        self.assertEqual((plan["complete"], len(plan["unreachable"]), plan["walk"]), (False, 16, [[1, 1]]))
        self.assertEqual(self.cli("--reachable-only", data="D" + "*" * 15).returncode, 2)
        self.assertEqual(self.cli("--reachable-only", "--max-load", "3", data="D4").returncode, 2)
        self.assertEqual(self.cli("--close", "1", "3", data="D*#").stdout, self.cli(data="D*#").stdout)

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
