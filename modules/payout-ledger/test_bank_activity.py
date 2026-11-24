from contextlib import closing, redirect_stderr, redirect_stdout
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from bank_activity import main
from examples.restaurant_demo import DAY, DAY_MS, MERCHANT, START, WALLET, seed_activity


class BankActivityTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = os.environ.get("HEY_TABLE_MIGRATIONS")
        self.db, self.snapshot = seed_activity(
            Path(folder.name) / "fixture", Path(path) if path else None
        )
        self.args = [
            str(self.db),
            "--day",
            DAY,
            "--environment",
            "sandbox",
            "--merchant",
            WALLET,
            "--merchant",
            MERCHANT,
        ]
        self.document = json.loads(self.snapshot.read_bytes())

    def cli(self, *flags, fetch=False):
        source = ["--fetch"] if fetch else ["--snapshot", str(self.snapshot)]
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main([*self.args, *source, *flags])
        return code, out.getvalue(), err.getvalue()

    def save(self):
        self.snapshot.write_text(json.dumps(self.document), encoding="utf8")

    def test_yesterday_sale_has_two_today_refunds_without_recounting_sale(self):
        initial = self.db.read_bytes()
        code, out, err = self.cli("--strict")
        self.assertEqual((code, err), (3, ""))
        self.assertNotIn("fixture-sensitive", out)
        report = json.loads(out)
        self.assertEqual(report["net_twd"], 30)
        self.assertEqual(
            report["by_method"]["line_pay"],
            {
                "capture_twd": 0,
                "refund_twd": 50,
                "earlier_attempt_refund_twd": 50,
                "failed_actions": 1,
                "net_twd": -50,
            },
        )
        self.assertEqual(
            report["by_method"]["px_pay_plus"],
            {
                "capture_twd": 95,
                "refund_twd": 15,
                "earlier_attempt_refund_twd": 0,
                "failed_actions": 0,
                "net_twd": 80,
            },
        )
        self.assertEqual(
            [event["order_id"] for event in report["events"]], [2, 3, 2, 2, 3]
        )
        self.assertEqual(report["events"][0]["bank_ms"], START)
        self.assertLess(report["events"][0]["trigger_ms"], START)
        self.assertEqual(report["events"][-1]["bank_ms"], START + DAY_MS - 1)
        self.assertEqual(
            [r["reasons"] for r in report["issues"]], [["bank_action_failed"]]
        )
        self.assertEqual(self.db.read_bytes(), initial)

    def test_local_identifier_and_currency_mismatches_never_attach_an_order(self):
        rows = self.document["pages"][0]["reconciliation_datas"]
        rows[0]["bank_transaction_id"] = (
            "L1"  # Ref points to a different attempt than trade ID.
        )
        rows[1]["payment_method"] = "plus_pay"
        rows[2]["currency"] = "USD"
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE payment_attempts SET trade_id=NULL WHERE reference='P1'")
        self.save()
        code, out, _ = self.cli("--strict")
        self.assertEqual(code, 3)
        report = json.loads(out)
        self.assertEqual(report["excluded_by_currency"], {"USD": 1})
        self.assertEqual(
            report["issues"][0]["reasons"], ["conflicting_local_identifiers"]
        )
        self.assertEqual(
            report["issues"][1]["reasons"], ["trade_id_mismatch", "method_mismatch"]
        )
        self.assertIsNone(report["events"][0]["order_id"])
        self.assertEqual(
            report["by_method"]["line_pay"]["earlier_attempt_refund_twd"], 0
        )

    def test_fails_closed_for_missing_pages_duplicate_events_and_scope_drift(self):
        base = self.snapshot.read_bytes()

        def duplicate(document):
            row = document["pages"][0]["reconciliation_datas"][0]
            document["pages"][1]["reconciliation_datas"][0] = row

        def duplicate_ref(document):
            row = document["pages"][1]["reconciliation_datas"][-1]
            document["pages"][1]["reconciliation_datas"][0] = dict(
                row, bank_transaction_millis=START + 1
            )

        for change in [
            lambda d: d["pages"].pop(),
            lambda d: d["scope"].update(environment="production"),
            lambda d: d["pages"][0].update(number_of_transactions=4),
            lambda d: d["pages"][0]["reconciliation_datas"][0].update(
                bank_transaction_millis=START - 1
            ),
            lambda d: d["pages"][0]["reconciliation_datas"][0].update(
                bank_transaction_millis=START + DAY_MS
            ),
            lambda d: d["pages"][0]["reconciliation_datas"][0].update(
                transaction_result=1
            ),
            duplicate,
            duplicate_ref,
        ]:
            self.document = json.loads(base)
            with self.subTest(change=change):
                change(self.document)
                self.save()
                code, out, err = self.cli()
                self.assertEqual((code, out), (2, ""))
                self.assertTrue(err)

    def test_read_only_endpoint_paginates_with_same_day_and_merchants(self):
        seen = []

        def reply(req, timeout):
            self.assertEqual(
                req.full_url,
                "https://sandbox.tappaysdk.com/tpc/transaction/reconciliation",
            )
            self.assertEqual(req.get_header("X-api-key"), "fixture-key")
            self.assertEqual(timeout, 30)
            payload = json.loads(req.data)
            index = payload.pop("page")
            self.assertEqual(
                payload,
                dict(
                    {
                        k: v
                        for k, v in self.document["scope"].items()
                        if k != "environment"
                    },
                    records_per_page=200,
                    partner_key="fixture-key",
                ),
            )
            seen.append(index)
            return BytesIO(json.dumps(self.document["pages"][index]).encode())

        expected = self.cli()[1]
        with (
            patch.dict(os.environ, TAPPAY_PARTNER_KEY="fixture-key"),
            patch("bank_activity.build_opener") as opener,
        ):
            opener.return_value.open.side_effect = reply
            code, out, err = self.cli(fetch=True)
        self.assertEqual((code, out, err, seen), (0, expected, "", [0, 1]))

    def test_empty_day_uses_zero_and_can_run_in_strict_mode(self):
        self.document["pages"] = [
            {
                "status": 2,
                "page": 0,
                "number_of_transactions": 0,
                "total_page_count": 0,
                "reconciliation_datas": [],
            }
        ]
        self.save()
        code, out, err = self.cli("--strict")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out)["net_twd"], 0)
