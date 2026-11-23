from fractions import Fraction
from itertools import product
import json
from math import ceil, floor
from pathlib import Path
from random import Random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from split import split

ROOT = Path(__file__).resolve().parent


def oracle(receipt, shares, result):
    """Enumerate whole line allocations without using the implementation's network."""
    rows = receipt["items"]
    people = sorted({p for weights in shares.values() for p in weights})
    exact, options, produced = [], [], []
    for row in rows:
        total = row["price"] * row["qty"]
        weights = shares[row["id"]]
        ideal = [Fraction(total * weights.get(p, 0), sum(weights.values())) for p in people]
        exact.append(ideal)
        allowed = [range(floor(x), ceil(x) + 1) for x in ideal]
        options.append([v for v in product(*allowed) if sum(v) == total])
        allocation = result["lines"][row["id"]]
        assert set(allocation) == set(weights)
        actual = tuple(allocation.get(p, 0) for p in people)
        assert actual in options[-1]
        produced.append(actual)

    personal = [sum(col) for col in zip(*exact)]
    def cost(matrix):
        totals = list(map(sum, zip(*matrix)))
        if any(not floor(x) <= paid <= ceil(x) for x, paid in zip(personal, totals)):
            return None
        bill_error = sum(abs(x - paid) for x, paid in zip(personal, totals))
        line_error = sum(abs(x - paid) for row, allocation in zip(exact, matrix)
                         for x, paid in zip(row, allocation))
        return bill_error, line_error

    best = min(c for matrix in product(*options) if (c := cost(matrix)) is not None)
    assert cost(produced) == best
    for p, ideal, column in zip(people, personal, zip(*produced)):
        assert result["diners"][p] == {"exact": str(ideal), "pay": sum(column)}


class SplitTests(unittest.TestCase):
    def test_shared_sides_and_disconnected_diner_groups(self):
        receipt, shares = [json.loads((ROOT / "examples" / f"{n}.json").read_text("utf-8"))
                           for n in ("receipt", "shares")]
        result = split(receipt, shares)
        self.assertEqual([p["pay"] for p in result["diners"].values()], [260, 70])
        oracle(receipt, shares, result)
        receipt = {"total": 2, "items": [{"id": d, "price": 1, "qty": 1} for d in "xy"]}
        shares = {"x": {"A": 1, "B": 1}, "y": {"C": 1, "D": 1}}
        allocated = split(receipt, shares)
        oracle(receipt, shares, allocated)
        self.assertEqual(sum(allocated["diners"][p]["pay"] for p in "AB"), 1)
        self.assertEqual(sum(allocated["diners"][p]["pay"] for p in "CD"), 1)

    def test_weighted_receipts_match_exhaustive_two_level_optimum(self):
        rng = Random(2794)
        for i in range(240):
            items, shares = [], {}
            for j in range(rng.randint(1, 4)):
                dish = f"d{j}"
                items.append({"id": dish, "price": rng.randrange(9), "qty": rng.randint(1, 3)})
                shares[dish] = {p: rng.randint(1, 5) for p in rng.sample(list("ABCD"), rng.randint(1, 4))}
            receipt = {"items": items, "total": sum(r["price"] * r["qty"] for r in items)}
            with self.subTest(i=i):
                result = split(receipt, shares)
                oracle(receipt, shares, result)
                reordered = {d: dict(reversed(list(weights.items()))) for d, weights in reversed(list(shares.items()))}
                self.assertEqual(split(dict(receipt, items=items[::-1]), reordered), result)

    def test_precision_and_invalid_inputs(self):
        price = 2**70 + 1
        receipt = {"total": price, "items": [{"id": "tea", "price": price, "qty": 1}]}
        shares = {"tea": {"A": 3, "B": 7}}
        oracle(receipt, shares, split(receipt, shares))
        for bad in ({}, {"tea": {}}, {"tea": {"A": True}}, {"tea": {"A": -1}},
                    {"tea": {"": 1}}, dict(shares, fish={"A": 2})):
            with self.assertRaises(ValueError):
                split(receipt, bad)
        for bad in (dict(receipt, total=price - 1), dict(receipt, items=receipt["items"] * 2)):
            with self.assertRaises(ValueError):
                split(bad, shares)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "duplicates.json"
            path.write_text('{"tea":{"A":1,"A":2}}', encoding="utf-8")
            run = subprocess.run([sys.executable, ROOT / "split.py", ROOT / "examples/receipt.json", path],
                                 capture_output=True)
            self.assertEqual(run.returncode, 2)
            self.assertIn(b"Duplicate JSON key", run.stderr)
            self.assertFalse(run.stdout)
