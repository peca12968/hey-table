import itertools
import json
import os
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from matching import classify


ROOT = Path(__file__).resolve().parent
EXAMPLES = ROOT / "examples"


def exhaustive(deposits, windows):
    """Enumerate entire assignments, including the decision to skip an entry."""
    best = -1
    choices = {}

    def visit(index, used, path):
        nonlocal best, choices
        if index == len(deposits):
            if len(used) > best:
                best = len(used)
                choices = {entry: set() for _, entry in deposits}
            if len(used) == best:
                for (_, entry), value in zip(deposits, path):
                    choices[entry].add(value)
            return
        posted, _ = deposits[index]
        visit(index + 1, used, path + [None])
        for first, last, batch in windows:
            if batch not in used and first <= posted <= last:
                visit(index + 1, used | {batch}, path + [batch])

    visit(0, set(), [])
    return best, {entry: (sorted(opts - {None}), None in opts) for entry, opts in choices.items()}


class MatchingTests(unittest.TestCase):
    def test_all_343_three_window_layouts_against_complete_assignments(self):
        dates = [(day, str(day)) for day in range(3)]
        intervals = list(itertools.combinations_with_replacement(range(3), 2)) + [(9, 9)]
        for layout in itertools.product(intervals, repeat=3):
            windows = [(first, last, i) for i, (first, last) in enumerate(layout)]
            self.assertEqual(classify(dates, windows), exhaustive(dates, windows), layout)

    def test_300_seeded_statements_with_collisions_and_unequal_sides(self):
        rng = random.Random(9001)
        for _ in range(300):
            entries = [(rng.randrange(5), i) for i in range(rng.randrange(7))]
            windows = [(*sorted([rng.randrange(5), rng.randrange(5)]), i) for i in range(rng.randrange(7))]
            self.assertEqual(classify(entries, windows), exhaustive(entries, windows), (entries, windows))

    def test_long_chain_has_one_assignment_without_recursion(self):
        n = 5000
        size, options = classify([(i, i) for i in range(n)], [(max(0, i-1), i, i) for i in range(n)])
        self.assertEqual(size, n)
        self.assertTrue(all(options[i] == ([i], False) for i in range(n)))


class ReviewTests(unittest.TestCase):
    def cli(self, report, windows=EXAMPLES/"windows.csv"):
        return subprocess.run([sys.executable, ROOT/"remit.py", report, windows],
                              text=True, encoding="utf8", capture_output=True)

    def check_demo(self, source):
        response = self.cli(source)
        self.assertEqual(response.returncode, 0, response.stderr)
        result = json.loads(response.stdout)
        self.assertEqual(result["maximum_pairs"], 6)
        self.assertEqual(result["missing_windows"], [{"account": "food", "payout_id": "F"}])
        actual = {(r["account"], r["entry_id"]): (r["possible_payouts"], r["can_be_unassigned"], r["status"])
                  for r in result["entries"]}
        self.assertEqual(actual, {
            ("food", "D01"): (["A"], False, "unique_in_model"), ("food", "D02"): (["B"], False, "unique_in_model"),
            ("food", "D03"): (["C", "D"], False, "ambiguous"), ("food", "D04"): (["C", "D"], False, "ambiguous"),
            ("food", "D05"): (["E"], True, "ambiguous"), ("food", "D06"): (["E"], True, "ambiguous"),
            ("food", "D07"): ([], True, "no_candidate"), ("second", "D01"): (["A"], False, "unique_in_model")})

    def test_bundled_payout_report(self):
        self.check_demo(EXAMPLES/"close.json")

    @unittest.skipUnless(os.environ.get("PAYOUT_BANK_CLOSE"), "Set PAYOUT_BANK_CLOSE to exercise upstream CLI")
    def test_regenerate_using_pinned_payout_ledger(self):
        with TemporaryDirectory() as temp:
            fresh = Path(temp)/"close.json"
            fresh.write_bytes(subprocess.check_output([sys.executable, os.environ["PAYOUT_BANK_CLOSE"],
                                                       EXAMPLES/"notices.csv", EXAMPLES/"bank.csv"]))
            self.assertEqual(json.loads(fresh.read_bytes()), json.loads((EXAMPLES/"close.json").read_bytes()))
            self.check_demo(fresh)

    def test_bad_or_repeated_source_records_return_no_partial_report(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            report = json.loads((EXAMPLES/"close.json").read_bytes())
            report["unassigned_bank_entries"] *= 2
            source = folder/"invalid.json"
            source.write_text(json.dumps(report), encoding="utf8")
            for change in ["food,A,2026-11-23,2026-11-21", "food,unknown,2026-11-23,2026-11-23",
                           "food,A,2026-11-23,2026-11-23\nfood,A,2026-11-23,2026-11-23"]:
                windows = folder/"invalid.csv"
                windows.write_text("account,payout_id,first_date,last_date\n"+change+"\n", encoding="utf8")
                result = self.cli(EXAMPLES/"close.json", windows)
                self.assertEqual((result.returncode, result.stdout), (2, ""))
            result = self.cli(source)
            self.assertEqual((result.returncode, result.stdout), (2, ""))


if __name__ == "__main__":
    unittest.main()
