from contextlib import closing, redirect_stderr, redirect_stdout
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from examples.restaurant_demo import DAY, MERCHANT, START, WALLET, seed_split
from restaurant_close import main, reconcile_merchant


class MerchantCloseTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        migrations = os.environ.get("HEY_TABLE_MIGRATIONS")
        self.db, self.base, self.wallet = seed_split(Path(temp.name)/"shift", Path(migrations) if migrations else None)

    def run_close(self, merchants=(MERCHANT, WALLET), snapshots=None, live=False, strict=False):
        args = [str(self.db), "--day", DAY, "--environment", "sandbox"]
        for merchant in merchants:
            args.extend(["--merchant", merchant])
        if live:
            args.append("--fetch")
        else:
            for path in (self.base, self.wallet) if snapshots is None else snapshots:
                args.extend(["--snapshot", str(path)])
        if strict:
            args.append("--strict")
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(args)
        return code, out.getvalue(), err.getvalue()

    def test_combined_report_matches_independent_accounts_and_labels_exceptions(self):
        code, out, err = self.run_close()
        self.assertEqual((code, err), (0, ""))
        combined = json.loads(out)
        self.assertEqual(combined["scope"]["merchants"], [MERCHANT, WALLET])
        self.assertEqual(combined["gateway_net_twd"], 360)
        self.assertEqual(combined["gateway_by_method"]["line_pay"]["net_twd"], 240)
        self.assertEqual(combined["gateway_by_method"]["px_pay_plus"]["refunded_twd"], 15)
        for merchant, path, net in [(MERCHANT, self.base, 160), (WALLET, self.wallet, 200)]:
            single = json.loads(self.run_close([merchant], [path])[1])
            subtotal = combined["by_merchant"][merchant]
            self.assertEqual(subtotal["gateway_net_twd"], net)
            self.assertEqual(subtotal["reason_counts"], single["reason_counts"])
            self.assertEqual(subtotal["gateway_by_method"], single["gateway_by_method"])
            self.assertEqual(single["multiple_collections"], [])
        self.assertEqual({(e["merchant"], e["reference"]) for e in combined["exceptions"]},
                         {(MERCHANT, "X1"), (MERCHANT, "J1"), (WALLET, "P1"), (WALLET, "L1")})
        self.assertEqual(self.run_close([WALLET, MERCHANT, WALLET], [self.wallet, self.base])[1], out)
        self.assertNotIn("private-ticket", out)

    def test_only_cross_account_duplicate_triggers_strict_even_across_midnight(self):
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("DELETE FROM payment_attempts WHERE reference NOT IN ('L1','L2')")
            db.execute("UPDATE payment_attempts SET state='paid',created=? WHERE reference='L1'", (START-1,))
        for path in (self.base, self.wallet):
            data = json.loads(path.read_text())
            page, = data["pages"]
            page["trade_records"] = [r for r in page["trade_records"] if r["bank_transaction_id"] in ("L1","L2")]
            page["number_of_transactions"] = len(page["trade_records"])
            path.write_text(json.dumps(data))
        code, out, _ = self.run_close(strict=True)
        result = json.loads(out)
        self.assertEqual((code, result["exceptions"], result["gateway_net_twd"]), (3, [], 120))
        self.assertEqual(result["multiple_collections"], [{"order_id": 2, "payments": [
            {"merchant": MERCHANT, "reference": "L2", "trade_id": "L-TWO", "in_day": True},
            {"merchant": WALLET, "reference": "L1", "trade_id": "L-ONE", "in_day": False}]}])
        # Refunding the other attempt removes the duplicate without changing today's net.
        data = json.loads(self.wallet.read_text())
        data["pages"][0]["trade_records"][0].update(record_status=3, amount=0)
        self.wallet.write_text(json.dumps(data))
        code, out, _ = self.run_close(strict=True)
        self.assertEqual((code, json.loads(out)["gateway_net_twd"]), (0, 120))

    def test_same_bank_reference_in_wrong_merchant_cannot_match_a_local_attempt(self):
        data = json.loads(self.base.read_text())
        orphan = next(r for r in data["pages"][0]["trade_records"] if r["bank_transaction_id"] == "X1")
        orphan.update(bank_transaction_id="P1")
        self.base.write_text(json.dumps(data))
        result = json.loads(self.run_close()[1])
        issues = {(e["merchant"], e["reference"]): e for e in result["exceptions"]}
        self.assertEqual(issues[MERCHANT, "P1"]["reasons"], ["provider_only"])
        self.assertIsNone(issues[MERCHANT, "P1"]["local"])
        self.assertEqual(issues[WALLET, "P1"]["local"]["order_id"], 3)
        self.assertEqual(result["gateway_net_twd"], 360)

    def test_incomplete_duplicate_and_cross_merchant_identity_abort_whole_report(self):
        for paths in ([self.base], [self.base, self.base]):
            self.assertEqual(self.run_close(snapshots=paths)[:2], (2, ""))
        initial = self.wallet.read_text()
        for mutate in (lambda d: d["scope"].update(environment="production"),
                       lambda d: d["pages"][0].update(total_page_count=2),
                       lambda d: d["pages"][0]["trade_records"][0].update(rec_trade_id="L-TWO"),
                       lambda d: d["pages"][0]["trade_records"][0].update(merchant_id=MERCHANT)):
            data = json.loads(initial)
            mutate(data)
            self.wallet.write_text(json.dumps(data))
            with self.subTest(mutate=mutate):
                self.assertEqual(self.run_close()[:2], (2, ""))

    def test_local_database_is_one_snapshot_across_merchants(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("PRAGMA journal_mode=WAL")
        prior = self.run_close()[1]
        def reconcile(db, scope, *args):
            result = reconcile_merchant(db, scope, *args)
            if scope["merchant"] == MERCHANT:
                with closing(sqlite3.connect(self.db)) as writer, writer:
                    writer.execute("UPDATE payment_attempts SET state='paid' WHERE reference='L1'")
            return result
        with patch("restaurant_close.reconcile_merchant", side_effect=reconcile):
            self.assertEqual(self.run_close()[1], prior)
        later = json.loads(self.run_close()[1])
        self.assertNotIn("state_mismatch", later["reason_counts"])

    def test_live_reader_is_scoped_and_aborts_on_second_account_error(self):
        pages = {m: json.loads(path.read_text())["pages"] for m, path in [(MERCHANT,self.base),(WALLET,self.wallet)]}
        seen = []
        def respond(req, timeout):
            body = json.loads(req.data)
            merchant, = body["filters"]["merchant_id"]
            seen.append(merchant)
            return BytesIO(json.dumps(pages[merchant][body["page"]]).encode())
        offline = self.run_close()
        with patch.dict(os.environ, TAPPAY_PARTNER_KEY="fake"), patch("restaurant_close.build_opener") as opener:
            opener.return_value.open.side_effect = respond
            self.assertEqual(self.run_close(live=True), offline)
            self.assertEqual(seen, [MERCHANT, WALLET])
            pages[WALLET][0] = {"status": 1}
            self.assertEqual(self.run_close(live=True)[:2], (2, ""))
