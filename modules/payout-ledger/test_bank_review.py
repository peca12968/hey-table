import csv
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

from bank_close import BANK, NOTICE, reconcile
from bank_review import CONFIRMATION


ROOT = Path(__file__).resolve().parent


class BankReviewTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.notices = self.root / "notices.csv"
        self.statement = self.root / "bank.csv"
        self.confirmation = self.root / "confirm.csv"
        self.output = self.root / "result.zip"
        self.original = [("A", "D1", "", "2026-11-22", 70), ("B", "D1", "", "2026-11-22", -25)]
        self.decision = ("A", "D1", "P", "2026-11-22", 70, "SLIP-1")
        self.write(self.notices, NOTICE, [("A","P","lunch","N","line_pay","collection",70)])
        self.write(self.statement, BANK, self.original + self.original[:1])
        self.write(self.confirmation, CONFIRMATION, [self.decision])

    def write(self, path, header, entries):
        with path.open("w", newline="", encoding="utf8") as stream:
            writer = csv.writer(stream)
            writer.writerow(header)
            writer.writerows(entries)

    def args(self):
        return [sys.executable, ROOT/"bank_review.py", self.notices, self.statement, self.confirmation, self.output]

    def run_cli(self, code=0):
        result = subprocess.run(self.args(), capture_output=True)
        self.assertEqual(result.returncode, code, result.stderr)
        if code:
            self.assertEqual(result.stdout, b"")
            return result.stderr
        return json.loads(result.stdout)

    def test_replay_uses_same_entry_scope_and_preserves_statement_and_totals(self):
        self.write(self.confirmation, CONFIRMATION, [self.decision, self.decision])
        original = self.statement.read_bytes()
        audit = self.run_cli()
        self.assertEqual(self.statement.read_bytes(), original)
        self.assertEqual(audit["duplicates_ignored"], {"bank": 1, "confirmations": 1, "notices": 0})
        self.assertEqual(audit["after"]["by_account"]["B"], audit["before"]["by_account"]["B"])
        self.assertEqual(audit["after"]["by_account"]["A"]["bank_twd"], 70)
        self.assertEqual(audit["after"]["unassigned_count"], 1)
        with ZipFile(self.output) as bundle:
            self.assertIsNone(bundle.testzip())
            self.assertEqual(json.loads(bundle.read("audit.json")), audit)
            original_report = json.loads(bundle.read("report.json"))
            normalized = bundle.read("bank.csv")
        self.statement = self.root/"normalized.csv"
        self.statement.write_bytes(normalized)
        self.assertEqual(original_report, reconcile(self.notices, self.statement))
        self.output = self.root/"replay.zip"
        replay = self.run_cli()
        self.assertEqual(replay["before"], replay["after"])
        self.assertEqual(replay["decisions"][0]["result"], "already_present")
        with ZipFile(self.output) as bundle:
            self.assertEqual(bundle.read("bank.csv"), normalized)
            self.assertEqual(json.loads(bundle.read("report.json")), original_report)

    def test_late_invalid_decision_cannot_publish_earlier_assignment(self):
        for bad in [("B","D1","Q","2026-11-22",25,"S"), ("B","D1","Q","2026-11-23",-25,"S"),
                    ("B","missing","Q","2026-11-22",-25,"S"), ("B","D1","Q","2026-11-22",-25,""),
                    ("A","D1","X","2026-11-22",70,"OTHER")]:
            with self.subTest(bad=bad):
                self.write(self.confirmation, CONFIRMATION, [self.decision, bad])
                self.run_cli(2)
                self.assertFalse(self.output.exists())
                self.assertEqual(len(reconcile(self.notices, self.statement)["unassigned_bank_entries"]), 2)
        self.write(self.statement, BANK, [("A","D1","EXISTING","2026-11-22",70)])
        self.write(self.confirmation, CONFIRMATION, [self.decision])
        self.assertIn(b"existing payout", self.run_cli(2))
        self.assertFalse(self.output.exists())

    def test_bank_evidence_can_identify_a_missing_notice_without_hiding_the_difference(self):
        self.write(self.confirmation, CONFIRMATION, [("B","D1","BANK-REF","2026-11-22",-25,"DEBIT")])
        audit = self.run_cli()
        self.assertEqual(audit["after"]["batch_counts"], {"bank_only": 1, "missing_bank": 1})
        self.assertFalse(audit["after"]["balanced"])

    def test_concurrent_publication_has_one_winner(self):
        processes = [subprocess.Popen(self.args(), stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
        outputs = [p.communicate(timeout=30) for p in processes]
        self.assertEqual(sorted(p.returncode for p in processes), [0, 2, 2, 2])
        with ZipFile(self.output) as bundle:
            self.assertIsNone(bundle.testzip())
            self.assertEqual(json.loads(next(out for out, _ in outputs if out)), json.loads(bundle.read("audit.json")))

    @unittest.skipUnless(os.environ.get("REMIT_MATCH_DIR"), "set REMIT_MATCH_DIR for the cross-project exercise")
    def test_matching_candidates_then_manual_review_then_new_candidates(self):
        partner = Path(os.environ["REMIT_MATCH_DIR"]).resolve()
        examples = partner/"examples"
        self.statement, self.notices = examples/"bank.csv", examples/"notices.csv"
        self.confirmation = ROOT/"examples/review-confirmations.csv"
        def candidates(report):
            return json.loads(subprocess.check_output([sys.executable, partner/"remit.py", report, examples/"windows.csv"]))
        before = candidates(examples/"close.json")
        self.assertEqual(before["maximum_pairs"], 6)
        choices = {r["entry_id"]: r["possible_payouts"] for r in before["entries"] if r["account"] == "food"}
        self.assertEqual(choices["D03"], choices["D04"])
        self.assertEqual(choices["D03"], ["C", "D"])
        audit = self.run_cli()
        self.assertEqual((audit["before"]["unassigned_count"], audit["after"]["unassigned_count"]), (8, 5))
        with ZipFile(self.output) as bundle:
            report = self.root/"reviewed.json"
            report.write_bytes(bundle.read("report.json"))
        matched = [(b["account"], b["payout_id"]) for b in json.loads(report.read_bytes())["batches"]
                   if b["status"] == "matched"]
        self.assertEqual(matched, [("food","C"), ("food","D"), ("second","A")])
        after = candidates(report)
        self.assertEqual((after["maximum_pairs"], len(after["entries"])), (3, 5))
        self.assertEqual({r["entry_id"] for r in after["entries"]}, {"D01", "D02", "D05", "D06", "D07"})
