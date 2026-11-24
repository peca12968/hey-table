from contextlib import closing, redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from examples.restaurant_demo import DAY, MERCHANT, START, WALLET, seed_funding
from restaurant_close import main


class WalletFundingTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        migrations = os.environ.get("HEY_TABLE_MIGRATIONS")
        self.db, self.base, self.other = seed_funding(Path(temp.name) / "day", Path(migrations) if migrations else None)

    def cli(self, *flags):
        args = [str(self.db), "--day", DAY, "--environment", "sandbox", "--merchant", MERCHANT, "--merchant", WALLET,
                "--snapshot", str(self.base), "--snapshot", str(self.other)]
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main([*args, *flags])
        return code, out.getvalue(), err.getvalue()

    def report(self):
        code, out, err = self.cli("--wallet-funding", "--strict")
        self.assertEqual((code, err), (0, ""))
        return json.loads(out)

    def test_partial_refund_and_missing_components_across_merchants(self):
        result = self.report()
        self.assertEqual(result["gateway_net_twd"], 569)
        funding = result["wallet_funding_by_method"]
        self.assertEqual(set(funding), {"pi_wallet", "px_pay_plus", "easy_wallet", "line_pay", "plus_pay", "jko_pay"})
        pi = funding["pi_wallet"]
        self.assertEqual(pi["paid_with_twd"], {"point": 70, "discount": 0, "credit_card": 160, "balance": 0,
                                               "bank_account": 70, "unclassified": 0})
        self.assertEqual(pi["returned_as_twd"], {"returned_reward_amount": 10, "returned_real_amount": 50,
                                                 "unclassified": 0})
        self.assertEqual(pi["unclassified_trade_ids"], [])
        self.assertEqual(funding["plus_pay"]["returned_as_twd"]["unclassified"], 90)
        self.assertEqual(funding["plus_pay"]["unclassified_trade_ids"], ["TRADE-4"])
        self.assertEqual(funding["px_pay_plus"]["paid_with_twd"]["unclassified"], 60)
        self.assertEqual(funding["jko_pay"]["paid_with_twd"]["unclassified"], 40)
        self.assertEqual(funding["line_pay"]["paid_with_twd"]["discount"], 20)
        self.assertEqual(funding["easy_wallet"]["paid_with_twd"]["balance"], 80)
        for report in [result, *result["by_merchant"].values()]:
            for method, item in report["wallet_funding_by_method"].items():
                totals = report["gateway_by_method"][method]
                paid = sum(item["paid_with_twd"].values())
                refunded = sum(item["returned_as_twd"].values())
                self.assertEqual((paid, refunded, paid-refunded),
                                 (totals["gross_twd"], totals["refunded_twd"], totals["net_twd"]))
        by_merchant = result["by_merchant"]
        for key in ("paid_with_twd", "returned_as_twd"):
            for field, amount in pi[key].items():
                self.assertEqual(sum(r["wallet_funding_by_method"]["pi_wallet"][key][field]
                                     for r in by_merchant.values()), amount)
        self.assertNotIn("wallet_funding_by_method", json.loads(self.cli()[1]))

    def test_midnight_ownership_and_safe_duplicate_projection(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE payment_attempts SET created=? WHERE reference='F1'", (START-1,))
        data = json.loads(self.base.read_text())
        page = data["pages"][0]
        page["total_page_count"] = 2
        duplicate = dict(page["trade_records"][1])
        duplicate["pay_info"] = dict(duplicate["pay_info"], identity="private-wallet", tool_name="private-bank")
        data["pages"].append(dict(page, page=1, trade_records=[duplicate]))
        self.base.write_text(json.dumps(data))
        result = self.report()
        self.assertEqual(result["repeated_source_rows"], 1)
        self.assertEqual(result["wallet_funding_by_method"]["pi_wallet"]["paid_with_twd"]["point"], 30)
        self.assertNotIn("private-", json.dumps(result))
        duplicate["pay_info"] = {"balance": 79, "point": 1}
        self.base.write_text(json.dumps(data))
        self.assertEqual(self.cli("--wallet-funding")[:2], (2, ""))

    def test_incomplete_refund_keeps_residual_without_assuming_cash(self):
        data = json.loads(self.base.read_text())
        row = data["pages"][0]["trade_records"][0]
        row["refund_info"] = {"returned_reward_amount": 10, "returned_real_amount": ""}
        self.base.write_text(json.dumps(data))
        pi = self.report()["wallet_funding_by_method"]["pi_wallet"]
        self.assertEqual(pi["returned_as_twd"], {"returned_reward_amount": 10, "returned_real_amount": 0,
                                                 "unclassified": 50})
        self.assertEqual(pi["unclassified_trade_ids"], ["TRADE-1"])

    def test_impossible_or_mistyped_amounts_fail_only_the_funding_report(self):
        data = json.loads(self.other.read_text())
        row = data["pages"][0]["trade_records"][0]
        for key, invalid in [("pay_info", {"point": 101}), ("pay_info", {"balance": True}),
                             ("pay_info", {"credit_card": -1}), ("pay_info", {"bank_account": "70"}),
                             ("refund_info", {"returned_reward_amount": 1}), ("refund_info", ["private-data"]),
                             ("refunded_amount", 12)]:
            with self.subTest(key=key, invalid=invalid):
                previous = row.get(key)
                row[key] = invalid
                self.other.write_text(json.dumps(data))
                code, out, err = self.cli("--wallet-funding")
                self.assertEqual((code, out), (2, ""))
                self.assertIn(key, err)
                self.assertNotIn("private-data", err)
                self.assertEqual(self.cli("--strict")[0], 0)
                row[key] = previous

    def test_unmatched_payment_exposes_only_amount_fields_from_provider_details(self):
        data = json.loads(self.base.read_text())
        row = data["pages"][0]["trade_records"][0]
        row["pay_info"].update(identity="private-id", masked_credit_card_number="private-card", bin_code="private-bin")
        row["refund_info"].update(provider_note="private-note")
        row["refunded_amount"] = 60
        self.base.write_text(json.dumps(data))
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE orders SET total=201 WHERE id=1")
        code, out, err = self.cli("--wallet-funding", "--strict")
        self.assertEqual((code, err), (3, ""))
        self.assertNotIn("private-", out)
        issue, = json.loads(out)["exceptions"]
        self.assertEqual(issue["reasons"], ["amount_mismatch"])
        self.assertEqual(issue["gateway"][0]["paid_with_twd"]["point"], 40)
