import contextlib
import io
import json
import sqlite3
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

    def invoke(self, orders=None, postings=None, strict=False):
        out, err = io.StringIO(), io.StringIO()
        args = [str(orders or EXAMPLES / "orders.csv"), str(postings or EXAMPLES / "postings.csv"),
                "--db", str(self.db)]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(args + (["--strict"] if strict else []))
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
