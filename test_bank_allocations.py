import csv
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from itertools import product
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from bank_close import ALLOCATION, BANK, NOTICE, apply_allocations, main, reconcile, reconcile_rows


EXAMPLES = Path(__file__).parent / "examples"
DAY = "2026-11-24"


class BankAllocationTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def feed(self, filename, fields, rows):
        path = self.root / filename
        with path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(fields)
            writer.writerows(rows)
        return path

    def cli(self, notices, bank, parts):
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main([str(notices), str(bank), "--allocations", str(parts), "--strict"])
        return code, out.getvalue(), err.getvalue()

    def test_example_two_transfers_each_include_two_payouts(self):
        notices, bank, parts = (EXAMPLES / name for name in
                                ("payout-notices.csv", "combined-bank.csv", "combined-allocations.csv"))
        self.assertEqual(len(reconcile(notices, bank)["unassigned_bank_entries"]), 2)
        code, out, err = self.cli(notices, bank, parts)
        self.assertEqual((code, err), (0, ""))
        report = json.loads(out)
        self.assertEqual(report["by_account"]["store-bank"], {
            "bank_twd":655, "expected_twd":655, "delta_twd":0, "unassigned_twd":0})
        self.assertEqual(report["batch_counts"], {"matched":2})
        self.assertEqual([b["bank_twd"] for b in report["batches"]], [450,205])
        self.assertEqual([a["statement_entry"]["amount_twd"] for a in report["documented_allocations"]], [500,155])
        self.assertEqual([p["evidence_ref"] for p in report["batches"][0]["bank_entries"]], ["slip-11","slip-12"])

    def test_account_scope_duplicates_and_still_unresolved_rows(self):
        notices = self.feed("notices", NOTICE, [("A","P","M","1","line_pay","collection",15)])
        a = ("A","E","",DAY,10)
        bank = self.feed("bank", BANK, [a, a, ("B","E","",DAY,10)])
        rows = [("A","E","P",DAY,15,10,"doc"), ("A","E","Q",DAY,-5,10,"doc")]
        parts = self.feed("parts", ALLOCATION, [rows[1], rows[0], rows[1]])
        code, out, _ = self.cli(notices, bank, parts)
        self.assertEqual(code, 3)
        report = json.loads(out)
        self.assertEqual(report["duplicates_ignored"], {"bank":1, "notice":0, "allocations":1})
        self.assertEqual(report["batch_counts"], {"matched":1, "bank_only":1})
        self.assertEqual(report["unassigned_bank_entries"][0]["account"], "B")
        self.assertEqual(report["documented_allocations"][0]["allocations"][1]["amount_twd"], -5)
        self.assertEqual(report, reconcile(notices, bank, self.feed("parts2", ALLOCATION, rows + rows[1:])))

    def test_invalid_evidence_is_atomic(self):
        notices = self.feed("notices", NOTICE, [])
        part = ["A","E","P",DAY,10,10,"slip"]
        plain = ("A","E","",DAY,10)
        for entry, rows in [
                (plain, [part, [*part[:6],"another-slip"]]),
                (plain, [[*part[:4],9,10,"slip"]]),
                (plain, [[*part[:5],"10.0","slip"]]),
                (plain, [[*part[:5],11,"slip"]]),
                (plain, [[*part[:3],"2026-11-25",*part[4:]]]),
                (plain, [["B",*part[1:]]]),
                (plain, [[*part[:6],""]]),
                (("A","E","P",DAY,10), [part])]:
            with self.subTest(entry=entry, rows=rows):
                bank = self.feed("bank", BANK, [entry])
                parts = self.feed("parts", ALLOCATION, rows)
                code, out, err = self.cli(notices, bank, parts)
                self.assertEqual((code, out), (2,""))
                self.assertTrue(err)

    def test_144_signed_two_by_two_remittances_against_independent_totals(self):
        cases = 0
        for a, b, c, d in product((-2,-1,1,2), repeat=4):
            if a + b == 0 or c + d == 0:
                continue  # The bank statement contract requires a booked nonzero transfer.
            cases += 1
            entries, parts = [], []
            for name, first, second in [("D1",a,b), ("D2",c,d)]:
                entry = dict(zip(BANK, ("A",name,"",DAY,first+second)))
                entries.append(entry)
                for batch, amount in [("P",first), ("Q",second)]:
                    parts.append(dict(zip(ALLOCATION, ("A",name,batch,DAY,amount,first+second,"doc"))))
            booked, audit = apply_allocations(entries, parts)
            result = reconcile_rows([], booked, 0, 0)
            self.assertEqual([r["bank_twd"] for r in result["batches"]], [a+c,b+d])
            self.assertEqual(result["by_account"]["A"]["bank_twd"], sum(e["amount_twd"] for e in entries))
            self.assertEqual([r["statement_entry"] for r in audit], entries)
        self.assertEqual(cases, 144)


if __name__ == "__main__":
    unittest.main()
