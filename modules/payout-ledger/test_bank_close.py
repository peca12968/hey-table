from contextlib import redirect_stderr, redirect_stdout
import csv
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from bank_close import BANK, NOTICE, main, reconcile


SAMPLES = Path(__file__).parent / "examples"


class BankCloseTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.advice = Path(temp.name) / "notices.csv"
        self.bank = Path(temp.name) / "bank.csv"

    def write(self, path, header, rows):
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(header)
            writer.writerows(rows)

    def cli(self, *args):
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main([str(a) for a in args])
        return code, out.getvalue(), err.getvalue()

    def test_equal_account_totals_still_fail_the_public_cli(self):
        args = (SAMPLES / "payout-notices.csv", SAMPLES / "bank-entries.csv")
        code, output, error = self.cli(*args, "--strict")
        self.assertEqual((code, error), (3, ""))
        report = json.loads(output)
        self.assertEqual(report["by_account"]["store-bank"], dict(expected_twd=655, bank_twd=655,
                                                                  delta_twd=0, unassigned_twd=0))
        a, b = report["batches"]
        self.assertEqual((a["delta_twd"], b["delta_twd"]), (-10, 10))
        self.assertEqual(a["components_twd"], {"collection": 500, "refund": 40, "fee": 10})
        self.assertEqual([r["entry_id"] for r in a["bank_entries"]], ["D01", "D02"])
        self.assertEqual({r["merchant"] for r in a["notice_lines"]}, {"dinner", "lunch"})
        self.assertEqual((b["bank_entries"][-1]["amount_twd"], b["bank_twd"]), (-5, 215))
        self.assertEqual(self.cli(*args)[0], 0)

    def test_same_payout_id_across_accounts_and_same_line_id_across_merchants(self):
        notices = [("A", "P", "east", "L", "card", "refund", 18),
                   ("A", "P", "east", "F", "card", "fee_return", 2),
                   ("B", "P", "west", "L", "line_pay", "collection", 16)]
        bank = [("A", "D", "P", "2026-11-24", -16), ("B", "D", "P", "2026-11-24", 16)]
        self.write(self.advice, NOTICE, notices + notices[:1])
        self.write(self.bank, BANK, bank + bank)
        report = reconcile(self.advice, self.bank)
        self.assertTrue(report["balanced"])
        self.assertEqual(report["batch_counts"], {"matched": 2})
        self.assertEqual(report["duplicates_ignored"], {"notice": 1, "bank": 2})
        self.assertEqual([b["expected_twd"] for b in report["batches"]], [-16, 16])
        self.write(self.advice, NOTICE, list(reversed(notices + notices[:1])))
        self.write(self.bank, BANK, list(reversed(bank + bank)))
        self.assertEqual(report, reconcile(self.advice, self.bank))

    def test_blank_reference_never_inferred_from_amount_and_orphan_bank_net_zero(self):
        self.write(self.advice, NOTICE, [("A","P","M","1","card","collection",50),
                                        ("A","Q","M","2","card","collection",80),
                                        ("A","Q","M","3","card","refund",80)])
        self.write(self.bank, BANK, [("A","D","","2026-11-24",50),
                                    ("A","E","X","2026-11-25",9),
                                    ("A","F","X","2026-11-26",-9)])
        report = reconcile(self.advice, self.bank)
        self.assertFalse(report["balanced"])
        self.assertEqual(report["batch_counts"], {"missing_bank": 1, "zero_net": 1, "bank_only": 1})
        self.assertEqual(report["by_account"]["A"]["delta_twd"], 0)
        self.assertEqual(report["by_account"]["A"]["unassigned_twd"], 50)
        self.assertEqual([r["entry_id"] for r in report["unassigned_bank_entries"]], ["D"])

    def test_fully_offset_notice_requires_no_transfer(self):
        self.write(self.advice, NOTICE, [("A","P","M","1","pi_wallet","collection",35),
                                        ("A","P","M","2","pi_wallet","refund",35)])
        self.write(self.bank, BANK, [])
        code, output, _ = self.cli(self.advice, self.bank, "--strict")
        self.assertEqual((code, json.loads(output)["batch_counts"]), (0, {"zero_net": 1}))

    def test_conflicting_source_ids_or_malformed_input_abort_without_report(self):
        notice = ["A", "P", "M", "L", "plus_pay", "collection", 50]
        bank = ["A", "D", "P", "2026-11-24", 50]
        for notices, entries in [
                ([notice, ["B", *notice[1:]]], [bank]),
                ([notice], [bank, [*bank[:2], "Q", *bank[3:]]]),
                ([notice], [[*bank[:3], "2026-11-31", 50]]),
                ([[*notice[:5], "fee", -50]], [bank]),
                ([notice], [[*bank[:-1], "50.01"]])]:
            with self.subTest(notices=notices, entries=entries):
                self.write(self.advice, NOTICE, notices)
                self.write(self.bank, BANK, entries)
                code, out, err = self.cli(self.advice, self.bank)
                self.assertEqual((code, out), (2, ""))
                self.assertIn("line ", err)


if __name__ == "__main__":
    unittest.main()
