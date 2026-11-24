from copy import deepcopy
import json
import os
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from drawer import read, reconcile


ROOT = Path(__file__).resolve().parent
EX = ROOT / "examples"


class DrawerTests(unittest.TestCase):
    def setUp(self):
        self.shift, self.replay, self.sheet = [read(EX / name) for name in ("lunch.json", "receipts.json", "counts.json")]

    def report(self):
        return reconcile(self.shift, self.replay, self.sheet)

    def test_lunch_cash_equation_and_change_in_discrepancy(self):
        result = self.report()
        noon, close = result["checks"]
        self.assertEqual([result[f] for f in ("opening_twd", "accepted_sales_twd", "added_twd", "removed_twd")],
                         [75, 425, 20, 200])
        self.assertEqual(result["rejected_payments"], 1)
        self.assertEqual((noon["status"], noon["expected_twd"], noon["counted_twd"]),
                         ("denomination_mismatch", 330, 330))
        self.assertEqual((close["expected_twd"], close["counted_twd"], close["status"]), (320, 310, "short"))
        self.assertEqual(close["change_since_previous_count"], [0, 0, -1, 0, 0])

    def test_repeated_drop_and_closed_sheet(self):
        result = self.report()
        self.sheet["events"].extend(deepcopy(self.sheet["events"]))
        self.assertEqual(self.report(), result)
        self.sheet["events"][-2]["counts"][-1] += 1
        with self.assertRaisesRegex(ValueError, "conflicting"):
            self.report()

    def test_positions_units_and_receipt_conservation(self):
        original = deepcopy((self.shift, self.replay, self.sheet))
        for mutate in (
            lambda: self.sheet["events"][0].update(after="missing"),
            lambda: self.sheet["events"].pop(),
            lambda: self.sheet["events"].reverse(),
            lambda: self.sheet["events"][-1].update(after="A05-edamame"),
            lambda: self.sheet["events"][2].update(counts=[0, 0, 0, 0, 6]),
            lambda: self.sheet["events"][0].update(counts=[True, 2, 1, 0, 0]),
            lambda: self.replay["receipts"][0]["drawer"].pop(),
            lambda: self.replay["receipts"][0].update(change=[0, 1, 0, 0, 0]),
            lambda: self.replay["receipts"].reverse(),
            lambda: self.replay["receipts"][2].update(status="underpaid"),
            lambda: self.replay["closing"].__setitem__(-1, 4),
            lambda: self.sheet.update(currency="USD"),
        ):
            self.shift, self.replay, self.sheet = deepcopy(original)
            mutate()
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                self.report()

    def test_safe_transfer_cannot_spend_coins_needed_for_a_later_receipt(self):
        self.sheet["events"][0].update(kind="remove", counts=[0, 3, 0, 0, 0])
        with self.assertRaisesRegex(ValueError, "intervening"):
            self.report()

    def test_empty_register_and_integer_precision(self):
        n = 2**53 + 1
        shift = {"denominations": [5], "opening": [n], "payments": []}
        replay = {"denominations": [5], "receipts": [], "closing": [n]}
        sheet = {"currency": "TWD", "events": [{"after": None, "id": "closing", "kind": "close", "counts": [n+1]}]}
        check, = reconcile(shift, replay, sheet)["checks"]
        self.assertEqual((check["expected_twd"], check["difference_twd"], check["status"]), (5*n, 5, "over"))

    def test_200_shift_sheets_against_independent_coin_inventory(self):
        rng = random.Random(3822)
        for _ in range(200):
            # Keep physical coins as individual values for an independent accounting oracle.
            values = [1, 5, 10]
            coins = [1, 5, 10] * 3
            till = list(coins)
            events, payments, receipts, observed = [], [], [], []
            previous = [0, 0, 0]
            def counts(bag):
                return [bag.count(v) for v in values]
            for i in range(6):
                ref = str(i)
                tender = rng.choices(values, k=3)
                change = rng.choice(tender)
                price = sum(tender) - change
                for bag in (till, coins):
                    bag.extend(tender)
                    bag.remove(change)
                payments.append({"id": ref, "price": price, "tender": counts(tender)})
                receipts.append({"id": ref, "paid": sum(tender), "status": "accepted",
                                 "change": counts([change]), "drawer": counts(till)})
                v = rng.choice(coins)
                kind = rng.choice(["add", "remove"])
                if kind == "add":
                    coins.append(v)
                else:
                    coins.remove(v)
                events.append({"id": "move"+ref, "after": ref, "kind": kind, "counts": counts([v])})
                counted = list(coins)
                if rng.randrange(2):
                    counted.pop(rng.randrange(len(counted)))
                else:
                    counted.append(rng.choice(values))
                diff = [counted.count(v) - coins.count(v) for v in values]
                observed.append((counts(coins), sum(counted)-sum(coins), [x-y for x,y in zip(diff, previous)]))
                previous = diff
                events.append({"id": "count"+ref, "after": ref, "kind": "close" if i == 5 else "count",
                               "counts": counts(counted)})
            result = reconcile({"payments": payments, "denominations": values, "opening": [3, 3, 3]},
                               {"receipts": receipts, "denominations": values, "closing": counts(till)},
                               {"currency": "TWD", "events": events})
            self.assertEqual([(r["expected"], r["difference_twd"], r["change_since_previous_count"])
                              for r in result["checks"]], observed)

    def test_cli_exit_codes_and_no_partial_report(self):
        with TemporaryDirectory() as folder:
            sheet = Path(folder) / "count.json"
            args = [sys.executable, ROOT / "drawer.py", EX / "lunch.json", EX / "receipts.json", sheet, "--strict"]
            def run():
                sheet.write_text(json.dumps(self.sheet), encoding="utf-8")
                return subprocess.run(args, capture_output=True)
            flagged = run()
            self.assertEqual((flagged.returncode, json.loads(flagged.stdout)["closing_status"]), (3, "short"))
            for event, check in zip(self.sheet["events"][1::2], self.report()["checks"]):
                event["counts"] = check["expected"]
            self.assertEqual(run().returncode, 0)
            self.sheet["events"].pop()
            bad = run()
            self.assertEqual((bad.returncode, bad.stdout), (2, b""))

    @unittest.skipUnless(os.environ.get("TILL_CHANGE_DLL"), "Set TILL_CHANGE_DLL for upstream integration")
    def test_actual_dotnet_register_receipts(self):
        result = subprocess.check_output(["dotnet", os.environ["TILL_CHANGE_DLL"], EX / "lunch.json"])
        self.assertEqual(json.loads(result), self.replay)
        self.assertEqual(reconcile(self.shift, json.loads(result), self.sheet)["closing_status"], "short")


if __name__ == "__main__":
    unittest.main()
