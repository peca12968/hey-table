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


def exhaustive(deposits, windows, excluded=frozenset()):
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
        posted, entry = deposits[index]
        visit(index + 1, used, path + [None])
        for first, last, batch in windows:
            if batch not in used and first <= posted <= last and (entry, batch) not in excluded:
                visit(index + 1, used | {batch}, path + [batch])

    visit(0, set(), [])
    return best, {entry: (sorted(opts - {None}), None in opts) for entry, opts in choices.items()}


class MatchingTests(unittest.TestCase):
    def test_every_filtered_three_by_three_graph(self):
        entries = [(0, i) for i in range(3)]
        windows = [(0, 0, i) for i in range(3)]
        edges = list(itertools.product(range(3), repeat=2))
        for mask in range(1 << len(edges)):
            excluded = {edge for bit, edge in enumerate(edges) if mask & (1 << bit)}
            self.assertEqual(classify(entries, windows, excluded),
                             exhaustive(entries, windows, excluded), mask)

    def test_reassign_entire_chain_after_last_selected_pair_is_excluded(self):
        n = 5000
        entries = [(i, i) for i in range(n)]
        windows = [(i, i + 1, i) for i in range(n - 1)] + [(0, n, n - 1)]
        excluded = {(i, n - 1) for i in range(1, n)}
        size, options = classify(entries, windows, excluded)
        self.assertEqual(size, n)
        for i in range(n):
            self.assertEqual(options[i], ([(i - 1) % n], False))

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
    def cli(self, report, windows=EXAMPLES/"windows.csv", *args):
        return subprocess.run([sys.executable, ROOT/"remit.py", report, windows, *args],
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

    def test_documented_exclusions_and_duplicate_source_refs(self):
        args = [EXAMPLES/"close.json", EXAMPLES/"windows.csv", "--exclusions"]
        path = EXAMPLES/"exclusions.csv"
        result = self.cli(*args, path)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["maximum_pairs"], 6)
        self.assertEqual(value["maximum_before_exclusions"], 6)
        self.assertEqual({r["entry_id"] for r in value["changed_entries"]}, {"D03","D04","D05","D06"})
        rows = {(r["account"],r["entry_id"]):r for r in value["entries"]}
        for entry, payouts in [("D03", ["D"]), ("D04", ["C"]), ("D05", []), ("D06", ["E"])]:
            row = rows["food",entry]
            self.assertEqual((row["possible_payouts"],row["can_be_unassigned"]), (payouts,not payouts))
        self.assertEqual(rows["second","D01"]["possible_payouts"], ["A"])
        with TemporaryDirectory() as temp:
            path2 = Path(temp)/"extra.csv"
            source = path.read_text(encoding="utf8")
            # The third exclusion makes A unreachable; only one of D01,D02 can take B.
            extra = "food,D01,A,2026-11-21,100,counterfoil-1\n"
            path2.write_text(source+extra+extra+extra.replace("foil-1","foil-2"), encoding="utf8")
            result = self.cli(*args, path2)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual(value["maximum_pairs"], 5)
            self.assertEqual(value["maximum_before_exclusions"], 6)
            impact = {r["entry_id"]:r for r in value["changed_entries"]}
            self.assertEqual(impact["D01"], {"account":"food","entry_id":"D01",
                             "added_payouts":["B"],"removed_payouts":["A"],
                             "could_be_unassigned_before":False,"can_be_unassigned_now":True})
            self.assertEqual(impact["D02"]["added_payouts"], [])
            self.assertEqual(impact["D02"]["removed_payouts"], [])
            self.assertTrue(impact["D02"]["can_be_unassigned_now"])
            self.assertEqual(value["excluded_pairs"][0]["evidence_refs"], ["counterfoil-1","counterfoil-2"])
            self.assertEqual(len(value["excluded_pairs"]), 3)
            for row in value["entries"]:
                if row["account"] == "food" and row["entry_id"] in ("D01","D02"):
                    self.assertEqual((row["possible_payouts"],row["can_be_unassigned"]), (["B"],True))

    def test_stale_or_incompatible_exclusions_have_no_partial_output(self):
        header, valid, _ = (EXAMPLES/"exclusions.csv").read_text(encoding="utf8").splitlines()
        bad = [valid.replace(",70,",",-70,"), valid.replace("D03","UNKNOWN"), valid.replace("food","second"),
               valid.replace(",C,",",A,"), valid.replace("-11-22","-11-23"), valid.rsplit(",",1)[0]+",",
               "food,D07,F,2026-11-22,25,missing-window", "food,D02,A,2026-11-22,100,outside-window"]
        with TemporaryDirectory() as temp:
            path = Path(temp)/"evidence.csv"
            for line in bad:
                path.write_text("\n".join((header,valid,line)), encoding="utf8")
                result = self.cli(EXAMPLES/"close.json", EXAMPLES/"windows.csv", "--exclusions", path)
                self.assertEqual((result.returncode, result.stdout), (2, ""), line)

    def test_refund_exclusion_is_scoped_to_its_account_and_signed_amount(self):
        header = (EXAMPLES/"exclusions.csv").read_text(encoding="utf8").splitlines()[0]
        with TemporaryDirectory() as temp:
            path = Path(temp)/"refund.csv"
            path.write_text(header+"\nsecond,D01,A,2026-11-22,-100,refund-slip\n", encoding="utf8")
            result = self.cli(EXAMPLES/"close.json", EXAMPLES/"windows.csv", "--exclusions", path)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertEqual((value["maximum_before_exclusions"],value["maximum_pairs"]), (6,5))
            self.assertEqual([(r["account"],r["entry_id"]) for r in value["changed_entries"]], [("second","D01")])

    @unittest.skipUnless(os.environ.get("PAYOUT_BANK_CLOSE"), "Set PAYOUT_BANK_CLOSE to exercise upstream CLI")
    def test_regenerate_using_pinned_payout_ledger(self):
        with TemporaryDirectory() as temp:
            fresh = Path(temp)/"close.json"
            fresh.write_bytes(subprocess.check_output([sys.executable, os.environ["PAYOUT_BANK_CLOSE"],
                                                       EXAMPLES/"notices.csv", EXAMPLES/"bank.csv"]))
            self.assertEqual(json.loads(fresh.read_bytes()), json.loads((EXAMPLES/"close.json").read_bytes()))
            self.check_demo(fresh)
            excluded = self.cli(fresh, EXAMPLES/"windows.csv", "--exclusions", EXAMPLES/"exclusions.csv")
            self.assertEqual(excluded.returncode, 0, excluded.stderr)
            self.assertEqual(json.loads(excluded.stdout)["maximum_pairs"], 6)

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
