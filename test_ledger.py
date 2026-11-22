import contextlib
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from ledger import main

EXAMPLES = Path(__file__).parent / "examples"


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.db = self.root / "snapshot.db"

    def invoke(self, orders=None, postings=None, strict=False, changes=False):
        out, err = io.StringIO(), io.StringIO()
        args = [str(orders or EXAMPLES / "orders.csv"), str(postings or EXAMPLES / "postings.csv"),
                "--db", str(self.db)]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(args + (["--strict"] if strict else []) + (["--changes"] if changes else []))
        return code, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()

    def feed(self, name, text):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_example_and_repeat(self):
        first = self.invoke()
        self.assertEqual(first, self.invoke())
        code, report, _ = first
        self.assertEqual(code, 0)
        self.assertEqual(report["matched"], 2)
        self.assertEqual(report["duplicates_ignored"]["postings"], 1)
        self.assertEqual(len(report["exceptions"]), 5)
        self.assertEqual(report["by_currency"]["USD"]["delta_minor"], -3150)
        self.assertEqual({r["state"] for r in report["exceptions"]},
                         {"orphan_posting", "missing_posting", "amount_mismatch"})
        self.assertEqual(self.invoke(strict=True)[0], 3)

    def test_bad_feed_rolls_back_both_tables(self):
        self.invoke()
        bad = self.feed("bad.csv", "posting_id,order_id,currency,amount_minor\nP,A,USD,1\nP,A,USD,2\n")
        code, _, err = self.invoke(postings=bad)
        self.assertEqual(code, 2)
        self.assertIn("conflicting duplicate", err)
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM postings").fetchone()[0], 6)
            self.assertEqual(db.execute("SELECT count(*) FROM orders").fetchone()[0], 5)

    def test_zero_amount_and_absent_posting(self):
        orders = self.feed("o.csv", "order_id,currency,amount_minor\nA,USD,0\nB,USD,0\n")
        postings = self.feed("p.csv", "posting_id,order_id,currency,amount_minor\nP,A,USD,0\n")
        _, report, _ = self.invoke(orders, postings)
        self.assertEqual(report["matched"], 1)
        self.assertEqual(report["exceptions"][0]["state"], "missing_posting")

    def test_rejects_fractional_amounts(self):
        bad = self.feed("bad.csv", "order_id,currency,amount_minor\nA,USD,1.50\n")
        self.assertEqual(self.invoke(orders=bad)[0], 2)

    def test_clean_snapshot_replaces_previous_data(self):
        self.invoke()
        orders = self.feed("orders.csv", "order_id,currency,amount_minor\n")
        postings = self.feed("postings.csv", "posting_id,order_id,currency,amount_minor\n")
        code, report, _ = self.invoke(orders, postings, strict=True)
        self.assertEqual(code, 0)
        self.assertEqual(report["by_currency"], {})

    def test_compare_uses_existing_snapshot_even_if_tracking_was_disabled(self):
        self.assertNotIn("changes", self.invoke()[1])
        code, report, _ = self.invoke(postings=EXAMPLES / "postings-followup.csv", strict=True, changes=True)
        self.assertEqual(code, 3)
        changes = report["changes"]
        self.assertEqual([item["order_id"] for item in changes["new"]], ["O-777"])
        self.assertEqual([item["order_id"] for item in changes["absent"]], ["O-999"])
        self.assertEqual(len(changes["resolved"]), 1)
        resolved = changes["resolved"][0]
        self.assertEqual((resolved["before"]["order_id"], resolved["matched_minor"]), ("O-101", 4200))
        keys = [(item["after"]["order_id"], item["after"]["currency"]) for item in changes["ongoing"]]
        self.assertEqual(keys, [("O-104", "EUR"), ("O-103", "USD"), ("O-104", "USD")])
        partial = changes["ongoing"][1]
        self.assertEqual((partial["before"]["state"], partial["after"]["state"]),
                         ("missing_posting", "amount_mismatch"))
        self.assertEqual(partial["after"]["delta_minor"], -1500)

    def test_failed_import_keeps_baseline_and_repeat_has_no_new_exceptions(self):
        baseline = self.invoke(changes=True)[1]
        self.assertEqual(baseline["changes"]["new"], baseline["exceptions"])
        bad = self.feed("bad.csv", "posting_id,order_id,currency,amount_minor\nP,A,USD,bad\n")
        self.assertEqual(self.invoke(postings=bad, changes=True)[0], 2)
        repeated = self.invoke(changes=True)[1]["changes"]
        self.assertEqual(len(repeated["ongoing"]), 5)
        self.assertTrue(all(item["before"] == item["after"] for item in repeated["ongoing"]))
        for key in ["new", "resolved", "absent"]:
            self.assertEqual(repeated[key], [])

    def test_missing_orders_and_postings_do_not_prove_settlement(self):
        self.invoke()
        orders = self.feed("orders.csv", "order_id,currency,amount_minor\n")
        postings = self.feed("postings.csv", "posting_id,order_id,currency,amount_minor\n")
        changes = self.invoke(orders, postings, changes=True)[1]["changes"]
        self.assertEqual(changes["resolved"], [])
        self.assertEqual(len(changes["absent"]), 5)

    def test_parallel_cli_imports_compare_with_the_last_committed_writer(self):
        # Each snapshot has one missing posting. Only the second writer can see the other's order.
        postings = self.feed("empty.csv", "posting_id,order_id,currency,amount_minor\n")
        jobs = []
        for order in ["A", "B"]:
            source = self.feed(f"{order}.csv", f"order_id,currency,amount_minor\n{order},USD,1\n")
            args = [sys.executable, str(EXAMPLES.parent / "ledger.py"), str(source), str(postings),
                    "--db", str(self.db), "--changes"]
            jobs.append(subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        results = []
        for job in jobs:
            stdout, stderr = job.communicate(timeout=20)
            self.assertEqual(job.returncode, 0, stderr)
            results.append(json.loads(stdout)["changes"])
        first, second = sorted(results, key=lambda result: len(result["absent"]))
        self.assertEqual(first["absent"], [])
        self.assertEqual(second["absent"], first["new"])
        self.assertEqual({first["new"][0]["order_id"], second["new"][0]["order_id"]}, {"A", "B"})
