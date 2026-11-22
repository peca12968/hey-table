import contextlib
import io
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from ledger import main, reconcile

EXAMPLES = Path(__file__).parent / "examples"


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.db = self.root / "snapshot.db"

    def invoke(self, orders=None, postings=None, strict=False, changes=False, explain=False):
        out, err = io.StringIO(), io.StringIO()
        args = [str(orders or EXAMPLES / "orders.csv"), str(postings or EXAMPLES / "postings.csv"),
                "--db", str(self.db)]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(args + (["--strict"] if strict else []) + (["--changes"] if changes else [])
                        + (["--explain"] if explain else []))
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

    def test_example_explains_four_usd_movements_and_keeps_other_currencies_separate(self):
        self.assertNotIn("movements_by_currency", self.invoke()[1])
        followup = EXAMPLES / "postings-followup.csv"
        code, report, _ = self.invoke(postings=followup, explain=True, strict=True)
        self.assertEqual(code, 3)
        self.assertNotIn("changes", report)
        movements = report["movements_by_currency"]
        usd = movements["USD"]
        self.assertEqual((usd["opening_delta_minor"], usd["change_minor"], usd["closing_delta_minor"]),
                         (-3150, 700, -2450))
        self.assertEqual([(r["record_id"], r["effect_minor"]) for r in usd["lines"]],
                         [("P-05", -800), ("P-07", 200), ("P-08", 1000), ("P-09", 300)])
        self.assertIsNone(usd["lines"][0]["after_minor"])
        for currency, expected in [("EUR", 1250), ("TWD", 0)]:
            self.assertEqual(movements[currency], {"opening_delta_minor": expected, "change_minor": 0,
                                                  "closing_delta_minor": expected, "lines": []})
        repeat = self.invoke(postings=followup, changes=True, explain=True)[1]
        self.assertIn("changes", repeat)
        for bridge in repeat["movements_by_currency"].values():
            self.assertEqual(bridge["lines"], [])
            self.assertEqual(bridge["change_minor"], 0)

    def test_moves_refunds_zero_amounts_and_disappearing_currency(self):
        order_head = "order_id,currency,amount_minor\n"
        posting_head = "posting_id,order_id,currency,amount_minor\n"
        old_orders = self.feed("old-o.csv", order_head + "A,USD,100\nB,JPY,0\nC,EUR,70\n")
        new_orders = self.feed("new-o.csv", order_head + "A,USD,120\nC,USD,70\n")
        old_posts = self.feed("old-p.csv", posting_head + "P,A,USD,-20\nQ,A,USD,40\nR,C,EUR,70\n")
        new_posts = self.feed("new-p.csv", posting_head + "P,A,USD,-50\nQ,C,USD,40\nR,C,USD,70\n")
        first = self.invoke(old_orders, old_posts, explain=True)[1]["movements_by_currency"]
        self.assertEqual(first["USD"]["opening_delta_minor"], 0)
        result = self.invoke(new_orders, new_posts, explain=True)[1]["movements_by_currency"]
        def amounts(currency):
            return [(r["source"], r["record_id"], r["order_id"], r["before_minor"], r["after_minor"],
                     r["effect_minor"]) for r in result[currency]["lines"]]
        self.assertEqual(amounts("JPY"), [("orders", "B", "B", 0, None, 0)])
        self.assertEqual(amounts("EUR"), [("orders", "C", "C", 70, None, 70),
                                         ("postings", "R", "C", 70, None, -70)])
        self.assertEqual(amounts("USD"), [("orders", "A", "A", 100, 120, -20),
                                         ("orders", "C", "C", None, 70, -70),
                                         ("postings", "P", "A", -20, -50, -30),
                                         ("postings", "Q", "A", 40, None, -40),
                                         ("postings", "Q", "C", None, 40, 40),
                                         ("postings", "R", "C", None, 70, 70)])
        self.assertEqual((result["USD"]["opening_delta_minor"], result["USD"]["closing_delta_minor"]),
                         (-80, -130))
        self.assertEqual(result["EUR"]["change_minor"], 0)
        self.assertEqual(result["JPY"]["closing_delta_minor"], 0)

    def test_failed_import_preserves_baseline_and_allows_same_connection_retry(self):
        bad = self.feed("bad.csv", "posting_id,order_id,currency,amount_minor\nP,A,USD,not-money\n")
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            orders = EXAMPLES / "orders.csv"
            reconcile(db, orders, EXAMPLES / "postings.csv", explain=True)
            with self.assertRaises(ValueError):
                reconcile(db, orders, bad, explain=True)
            report = reconcile(db, orders, EXAMPLES / "postings-followup.csv", explain=True)
            self.assertEqual(report["movements_by_currency"]["USD"]["opening_delta_minor"], -3150)
            self.assertEqual(db.execute("SELECT count(*) FROM sqlite_temp_master").fetchone()[0], 0)

    def test_single_unit_change_above_float_precision_remains_exact(self):
        orders = self.feed("orders.csv", "order_id,currency,amount_minor\n")
        header = "posting_id,order_id,currency,amount_minor\n"
        amount = 999_999_999_999
        count = 9010
        body = "".join(f"P{i},A,USD,{amount}\n" for i in range(count))
        postings = self.feed("postings.csv", header + body)
        self.assertEqual(self.invoke(orders, postings)[0], 0)
        with postings.open("a", encoding="utf-8") as stream:
            stream.write("adjustment,A,USD,-1\n")
        movement = self.invoke(orders, postings, explain=True)[1]["movements_by_currency"]["USD"]
        self.assertGreater(count * amount, 2**53)
        self.assertEqual(movement["opening_delta_minor"], count * amount)
        self.assertEqual(movement["closing_delta_minor"], count * amount - 1)
        self.assertEqual(movement["change_minor"], -1)
        self.assertEqual([r["effect_minor"] for r in movement["lines"]], [-1])

    def test_parallel_cli_imports_compare_with_the_last_committed_writer(self):
        # Each snapshot has one missing posting. Only the second writer can see the other's order.
        postings = self.feed("empty.csv", "posting_id,order_id,currency,amount_minor\n")
        jobs = []
        for order in ["A", "B"]:
            source = self.feed(f"{order}.csv", f"order_id,currency,amount_minor\n{order},USD,1\n")
            args = [sys.executable, str(EXAMPLES.parent / "ledger.py"), str(source), str(postings),
                    "--db", str(self.db), "--changes", "--explain"]
            jobs.append(subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        results = []
        for job in jobs:
            stdout, stderr = job.communicate(timeout=20)
            self.assertEqual(job.returncode, 0, stderr)
            report = json.loads(stdout)
            movement = report["movements_by_currency"]["USD"]
            next_order = report["changes"]["new"][0]["order_id"]
            effects = {line["order_id"]: line["effect_minor"] for line in movement["lines"]}
            self.assertEqual(effects.pop(next_order), -1)
            absent = report["changes"]["absent"]
            self.assertEqual(effects, {row["order_id"]: 1 for row in absent})
            self.assertEqual(movement["opening_delta_minor"], -len(absent))
            results.append(report["changes"])
        first, second = sorted(results, key=lambda result: len(result["absent"]))
        self.assertEqual(first["absent"], [])
        self.assertEqual(second["absent"], first["new"])
        self.assertEqual({first["new"][0]["order_id"], second["new"][0]["order_id"]}, {"A", "B"})
