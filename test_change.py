"""Compare the compiled register with exhaustive cash combinations, including every drawer update."""
from itertools import product
import json
from pathlib import Path
import random
import subprocess
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parent
APP = ROOT / "bin/Release/net10.0/TillChange.dll"


def run(shift, success=True):
    with TemporaryDirectory() as folder:
        path = Path(folder) / "shift.json"
        path.write_text(json.dumps(shift), encoding="utf-8")
        result = subprocess.run(["dotnet", APP, path], capture_output=True, encoding="utf-8")
    if not success:
        return result
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def value(values, counts):
    return sum(v * n for v, n in zip(values, counts))


class TillTests(unittest.TestCase):
    def test_lunch_register_uses_reserve_only_when_needed(self):
        shift = json.loads((ROOT / "examples/lunch.json").read_text("utf-8"))
        first, second, declined, last = run(shift)["receipts"]
        self.assertEqual(first["change"], [0, 2, 0, 0, 0])
        self.assertEqual(second["change"], [0, 1, 0, 1, 0])
        self.assertEqual((declined["status"], declined["drawer"]), ("no_exact_change", second["drawer"]))
        self.assertEqual((last["reserveUsed"], last["change"]), (1, [0, 0, 1, 0, 0]))
        self.assertEqual(last["drawer"], [0, 0, 0, 0, 5])

    def test_drawer_paths_match_all_feasible_change_combinations(self):
        rng = random.Random(3819)
        for _ in range(64):
            values = sorted(rng.sample(range(1, 11), 4))
            opening = [rng.randrange(4) for _ in values]
            reserve = [rng.randrange(4) for _ in values]
            payments = []
            for i in range(8):
                tender = [rng.randrange(2) for _ in values]
                price = max(0, value(values, tender) - rng.randrange(-2, 17))
                payments.append({"id": str(i), "tender": tender, "price": price})
            shift = {"denominations": values, "opening": opening, "reserve": reserve, "payments": payments}
            result = run(shift)
            self.assertEqual(len(result["receipts"]), len(payments))
            drawer = opening
            for payment, receipt in zip(payments, result["receipts"]):
                paid = value(values, payment["tender"])
                due = paid - payment["price"]
                available = [a + b for a, b in zip(drawer, payment["tender"])]
                def score(coins):
                    damage = sum(max(0, used - max(0, have - floor))
                                 for used, have, floor in zip(coins, available, reserve))
                    return damage, sum(coins)
                feasible = (c for c in product(*(range(1 + min(n, max(0, due) // v))
                                                  for v, n in zip(values, available))) if value(values, c) == due)
                best = min(map(score, feasible), default=None)
                self.assertEqual(receipt["paid"], paid)
                if best is None:
                    self.assertEqual(receipt["status"], "underpaid" if due < 0 else "no_exact_change")
                    self.assertEqual(receipt["change"], [0] * len(values))
                else:
                    self.assertEqual(receipt["status"], "accepted")
                    coins = receipt["change"]
                    self.assertEqual(score(coins), best)
                    self.assertEqual(receipt["reserveUsed"], best[0])
                    self.assertTrue(all(0 <= n <= cap for n, cap in zip(coins, available)))
                    self.assertEqual(value(values, coins), due)
                    self.assertEqual(value(values, drawer) + payment["price"], value(values, receipt["drawer"]))
                    drawer = [have - n for have, n in zip(available, coins)]
                self.assertEqual(receipt["drawer"], drawer)
            self.assertEqual(result["closing"], drawer)

    def test_large_coin_counts_and_input_validation(self):
        shift = {"denominations": [1, 100000], "opening": [2_000_000_000, 0], "reserve": [0, 0],
                 "payments": [{"id": "bulk", "price": 1, "tender": [0, 1]}]}
        self.assertEqual(run(shift)["receipts"][0]["change"], [99_999, 0])
        for change in ({"denominations": [1, 1]}, {"opening": [1]}, {"reserve": [-1, 0]},
                       {"payments": shift["payments"] * 2}, {"payments": [None]},
                       {"payments": [{"id": "x", "price": 1, "tender": [0, 2]}]}):
            result = run(dict(shift, **change), success=False)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
