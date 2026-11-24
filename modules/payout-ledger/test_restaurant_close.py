import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from examples.restaurant_demo import DAY, DAY_MS, MERCHANT, START, seed
from restaurant_close import main


class RestaurantCloseTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        migrations = os.environ.get("HEY_TABLE_MIGRATIONS")
        self.db, self.snapshot = seed(Path(temp.name)/"demo", Path(migrations) if migrations else None)
        self.args = [str(self.db), "--day", DAY, "--environment", "sandbox", "--merchant", MERCHANT]

    def run_cli(self, *flags, live=False):
        out, err = io.StringIO(), io.StringIO()
        args = self.args + (["--fetch"] if live else ["--snapshot", str(self.snapshot)])
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main([*args, *flags])
        return code, out.getvalue(), err.getvalue()

    def change(self, fn):
        data = json.loads(self.snapshot.read_text())
        fn(data)
        self.snapshot.write_text(json.dumps(data))

    def test_close_against_actual_order_and_retry_ids(self):
        before = self.db.read_bytes()
        code, out, err = self.run_cli("--strict")
        self.assertEqual((code, err), (3, ""))
        result = json.loads(out)
        self.assertEqual(result["matched_references"], 1)
        self.assertEqual(result["gateway_net_twd"], 360)
        self.assertEqual((result["local_attempts"], result["gateway_trades"]), (4, 4))
        self.assertEqual(result["multiple_collections"], [{"order_id": 2, "trade_ids": ["L-ONE", "L-TWO"]}])
        self.assertEqual(result["reason_counts"], {key: 1 for key in [
            "amount_mismatch", "state_mismatch", "provider_only", "local_only"]})
        self.assertNotIn("private-ticket", out)
        self.assertEqual(self.run_cli()[1], out)
        self.assertEqual(before, self.db.read_bytes())

    def test_method_subtotals_follow_gateway_and_reconcile_to_daily_net(self):
        result = json.loads(self.run_cli()[1])
        self.assertEqual(result["gateway_by_method"], {
            "line_pay": {"trades": 2, "states": {"paid": 2}, "gross_twd": 240, "refunded_twd": 0, "net_twd": 240},
            "px_pay_plus": {"trades": 1, "states": {"partial": 1}, "gross_twd": 95, "refunded_twd": 15, "net_twd": 80},
            "jko_pay": {"trades": 1, "states": {"paid": 1}, "gross_twd": 40, "refunded_twd": 0, "net_twd": 40},
        })
        self.assertEqual(sum(row["net_twd"] for row in result["gateway_by_method"].values()),
                         result["gateway_net_twd"])

    def test_full_refund_authorization_and_gateway_method_mismatch(self):
        def change(data):
            rows = data["pages"][0]["trade_records"]
            rows[1].update(payment_method="direct_pay", record_status=0)
            rows[2].update(record_status=3, amount=0)
            # The same record can appear twice when fetched in pages.
            data["pages"][1]["trade_records"].append(dict(rows[1]))
        self.change(change)
        result = json.loads(self.run_cli()[1])
        self.assertEqual(result["gateway_by_method"]["line_pay"],
                         {"trades": 1, "states": {"refunded": 1}, "gross_twd": 120, "refunded_twd": 120, "net_twd": 0})
        self.assertEqual(result["gateway_by_method"]["direct_pay"],
                         {"trades": 1, "states": {"authorized": 1}, "gross_twd": 0, "refunded_twd": 0, "net_twd": 0})
        self.assertEqual(result["repeated_source_rows"], 1)
        self.assertEqual(result["reason_counts"]["method_mismatch"], 1)

    def test_midnight_retry_flags_both_trades_without_inflating_daily_total(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE payment_attempts SET created=? WHERE reference='L1'", (START-1,))
        result = json.loads(self.run_cli()[1])
        self.assertEqual(result["gateway_net_twd"], 240)
        self.assertEqual(result["multiple_collections"], [{"order_id":2,"trade_ids":["L-ONE","L-TWO"]}])

    def test_midnight_boundaries(self):
        # The card attempt predates midnight, but the gateway saw it one millisecond after.
        self.args[self.args.index(DAY)] = "2026-11-22"
        def previous(data):
            data["scope"]["start_time"] -= DAY_MS
            data["scope"]["end_time"] -= DAY_MS
        self.change(previous)
        result = json.loads(self.run_cli("--strict")[1])
        self.assertEqual(result["gateway_net_twd"], 190)
        self.assertEqual(result["matched_references"], 1)
        self.assertEqual(result["exceptions"], [])

    def test_duplicate_lines_are_not_duplicate_collections(self):
        def duplicate(data):
            rows = data["pages"][1]["trade_records"]
            rows.append(dict(data["pages"][0]["trade_records"][1], cardholder={"name":"private-customer"}))
        self.change(duplicate)
        result = json.loads(self.run_cli()[1])
        self.assertEqual((result["repeated_source_rows"], result["gateway_net_twd"]), (1,360))
        self.assertNotIn("private-customer", str(result))

    def test_second_charge_under_same_reference_and_different_method(self):
        def change(data):
            pages = data["pages"]
            second = dict(pages[0]["trade_records"][2], rec_trade_id="T3", payment_method="direct_pay")
            pages[1]["trade_records"].append(second)
            for p in pages:
                p["number_of_transactions"] += 1
        self.change(change)
        result = json.loads(self.run_cli()[1])
        issue = next(e for e in result["exceptions"] if e["reference"]=="L2")
        self.assertEqual(set(issue["reasons"]), {"multiple_gateway_trades","method_mismatch","trade_id_mismatch"})
        self.assertEqual(result["multiple_collections"][0]["trade_ids"], ["L-ONE", "L-TWO", "T3"])

    def test_missing_or_shifted_pages_do_not_generate_a_report(self):
        initial = self.snapshot.read_bytes()
        for change in [
            lambda d: d["pages"].pop(),
            lambda d: d["pages"][1].update(page=3),
            lambda d: d["pages"][1].update(number_of_transactions=4),
            lambda d: d["pages"][1]["trade_records"].pop(),
            lambda d: d["pages"][0].update(status=False),
            lambda d: d["scope"].update(environment="production"),
            lambda d: d["pages"][0]["trade_records"][1].update(currency="USD"),
            lambda d: d["pages"][0]["trade_records"][1].update(time=START+4*DAY_MS),
            lambda d: d["pages"][1]["trade_records"].append(dict(d["pages"][0]["trade_records"][0], amount=111)),
        ]:
            with self.subTest(change=change):
                self.snapshot.write_bytes(initial)
                self.change(change)
                code, out, err = self.run_cli()
                self.assertEqual((code,out), (2,""))
                self.assertTrue(err)

    def test_online_reader_uses_only_record_api_and_all_pages(self):
        data = json.loads(self.snapshot.read_text())
        expected = self.run_cli()[1]
        seen = []
        def respond(req, timeout):
            self.assertEqual(req.full_url, "https://sandbox.tappaysdk.com/tpc/transaction/query")
            self.assertEqual(req.get_header("X-api-key"), "fake-test-key")
            body = json.loads(req.data)
            self.assertEqual(body["partner_key"], "fake-test-key")
            self.assertEqual(body["filters"], {"merchant_id":[MERCHANT],"currency":"TWD",
                             "time":{"start_time":START-DAY_MS,"end_time":START+2*DAY_MS-1}})
            seen.append(body["page"])
            return io.BytesIO(json.dumps(data["pages"][body["page"]]).encode())
        with patch.dict(os.environ,TAPPAY_PARTNER_KEY="fake-test-key"), patch("restaurant_close.build_opener") as opener:
            opener.return_value.open.side_effect=respond
            code, out, err = self.run_cli(live=True)
        self.assertEqual((code, out, err, seen), (0, expected, "", [0,1]))

    def test_authorization_and_fully_refunded_trade_contribute_no_collected_amount(self):
        def states(data):
            rows = data["pages"][0]["trade_records"]
            rows[1].update(record_status=0)
            rows[2].update(record_status=3, amount=0)
        self.change(states)
        result = json.loads(self.run_cli()[1])
        self.assertEqual(result["gateway_net_twd"], 120)
        self.assertEqual(result["multiple_collections"], [])

    def test_no_transactions_empty_snapshot_and_missing_database(self):
        def empty(data):
            data["pages"] = [dict(page=0,status=2,total_page_count=0,number_of_transactions=0,trade_records=[])]
        self.change(empty)
        self.assertEqual(json.loads(self.run_cli()[1])["reason_counts"], {"local_only":4})
        self.args[0] += ".absent"
        self.assertEqual(self.run_cli()[:2], (2,""))
        self.assertFalse(Path(self.args[0]).exists())


if __name__ == "__main__":
    unittest.main()
