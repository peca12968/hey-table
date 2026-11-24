from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from fractions import Fraction
from itertools import product
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from diner_credit import allocate_credit
from returns import connect, diner_credits, quote, register, void


ROOT = Path(__file__).resolve().parent
PAID = json.loads((ROOT/"examples/paid-split.json").read_bytes())
TICKET = json.loads((ROOT/"examples/ticket.json").read_bytes())


class CreditTests(unittest.TestCase):
    def test_every_prefix_of_625_splits_against_sorted_unit_priorities(self):
        for values in product(range(5), repeat=4):
            paid = dict(zip("abcd", values))
            units = sorted((-Fraction(value, k), name) for name, value in paid.items() for k in range(1, value+1))
            credit = dict.fromkeys(paid, 0)
            self.assertEqual(allocate_credit(paid, 0), credit)
            for i, (_, name) in enumerate(units, 1):
                credit[name] += 1
                self.assertEqual(allocate_credit(paid, i), credit, (paid, i))
        big = 2**51
        self.assertEqual(allocate_credit({"a": big, "b": big}, 2*big-1), {"a": big, "b": big-1})

    def test_split_is_frozen_and_credits_follow_active_returns(self):
        with closing(connect(":memory:")) as db:
            register(db, TICKET)
            with self.assertRaises(ValueError):
                diner_credits(db, 1)
            self.assertEqual(diner_credits(db, 1, PAID)["totalCredit"], 0)
            quote(db, 1, {"gyoza":1}, request="one", expected=85)
            first = diner_credits(db, 1)
            self.assertEqual(first["dishes"]["gyoza"]["credit"], {"小安":43,"小岑":42})
            self.assertEqual(diner_credits(db, 1, PAID), first)
            quote(db, 1, {"gyoza":1}, request="two", expected=72)
            self.assertEqual(diner_credits(db, 1)["dishes"]["gyoza"]["credit"], PAID["lines"]["gyoza"])
            quote(db, 1, {"oyakodon":1,"sencha":1}, request="rest", expected=188)
            all_back = diner_credits(db, 1)
            self.assertEqual([r["remaining"] for r in all_back["diners"].values()], [0,0])
            void(db, 1, "one", "wrong portion")
            after = diner_credits(db, 1)
            self.assertEqual(after["totalCredit"], 260)
            self.assertEqual(after["diners"], {"小安":{"paid":222,"credit":179,"remaining":43},
                                              "小岑":{"paid":123,"credit":81,"remaining":42}})

    def test_per_dish_totals_validated_even_when_overall_totals_agree(self):
        bad = deepcopy(PAID)
        bad["lines"]["gyoza"]["小安"] -= 1
        bad["lines"]["oyakodon"]["小安"] += 1
        with closing(connect(":memory:")) as db:
            register(db, TICKET)
            with self.assertRaisesRegex(ValueError, "Paid shares differ"):
                diner_credits(db, 1, bad)
            with self.assertRaisesRegex(ValueError, "Bind"):
                diner_credits(db, 1)

    def test_different_splits_compete_without_replacing_winner(self):
        alternative = deepcopy(PAID)
        alternative["lines"]["gyoza"] = {"小安":78,"小岑":79}
        alternative["diners"]["小安"]["pay"] -= 1
        alternative["diners"]["小岑"]["pay"] += 1
        with TemporaryDirectory() as temp:
            path = Path(temp)/"store.db"
            with closing(connect(path)) as db:
                register(db,TICKET)
            gate = Barrier(2)
            def submit(plan):
                with closing(connect(path)) as db:
                    gate.wait(timeout=10)
                    try:
                        return diner_credits(db, 1, plan)
                    except ValueError as error:
                        self.assertIn("different paid split", str(error))
                        return None
            with ThreadPoolExecutor(2) as workers:
                outcomes = list(workers.map(submit, (alternative, PAID)))
            winners = [r for r in outcomes if r is not None]
            with closing(connect(path)) as db:
                self.assertEqual(winners, [diner_credits(db, 1)])

    @unittest.skipUnless(os.environ.get("TABLE_SHARES_DIR"), "set TABLE_SHARES_DIR for cross-project pricing")
    def test_pinned_splitter_recreates_paid_amounts_from_the_original_quote(self):
        project = Path(os.environ["TABLE_SHARES_DIR"])
        with TemporaryDirectory() as temp:
            quote_path = Path(temp)/"quote.json"
            quote_path.write_text(json.dumps(TICKET["combo"]["quote"]), encoding="utf8")
            captured = subprocess.check_output([sys.executable, "-X", "utf8", project/"split.py", "--combo",
                                                quote_path, project/"examples/combo-shares.json"])
            self.assertEqual(json.loads(captured), PAID)
