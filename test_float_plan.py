from itertools import product
import json
from pathlib import Path
import random
import subprocess
import sys
import unittest

from float_plan import plan


ROOT = Path(__file__).resolve().parent


def coin_sets(limits):
    return product(*(range(n+1) for n in limits))


def exhaustive(values, opening, caps, payments):
    """Try every opening transfer and recursively hand out every affordable combination."""
    best = (0, 0, 0)

    def visit(depth, drawer, cost, pieces):
        nonlocal best
        best = min(best, (-depth, cost, pieces))
        if depth == len(payments):
            return
        row = payments[depth]
        available = [a+b for a,b in zip(drawer,row["tender"])]
        due = sum(v*t for v,t in zip(values,row["tender"])) - row["price"]
        if due < 0:
            return
        for change in coin_sets([min(a,due//v) for a,v in zip(available,values)]):
            if sum(v*c for v,c in zip(values,change)) == due:
                visit(depth+1, [a-c for a,c in zip(available,change)], cost, pieces+sum(change))

    for extra in coin_sets(caps):
        visit(0, [a+b for a,b in zip(opening,extra)], sum(v*n for v,n in zip(values,extra)), 0)
    return best


class FloatPlanTests(unittest.TestCase):
    def test_128_shifts_against_all_cash_sequences(self):
        rng = random.Random(9361)
        for index in range(128):
            values = [1,3,4]
            opening = [rng.randrange(3) for _ in values]
            caps = [rng.randrange(2) for _ in values]
            payments = []
            for step in range(3):
                tender = [rng.randrange(2) for _ in values]
                price = rng.randrange(sum(v*n for v,n in zip(values,tender))+2)
                payments.append(dict(id=str(step), tender=tender, price=price))
            result = plan(dict(denominations=values, opening=opening, reserve=[0]*3, payments=payments),
                          dict(denominations=values, available=caps))
            with self.subTest(index=index):
                self.assertEqual((-len(result["steps"]), result["topUpValue"], result["piecesReturned"]),
                                 exhaustive(values, opening, caps, payments))
                drawer = [a+b for a,b in zip(opening,result["topUp"])]
                self.assertTrue(all(0 <= a <= b for a,b in zip(result["topUp"],caps)))
                for row, actual in zip(payments, result["steps"]):
                    delta = [a-b for a,b in zip(row["tender"],actual["change"])]
                    self.assertEqual(sum(v*n for v,n in zip(values,delta)), row["price"])
                    drawer = [a+b for a,b in zip(drawer,delta)]
                    self.assertTrue(all(n >= 0 for n in drawer))
                    self.assertEqual(drawer, actual["drawer"])
                self.assertEqual(drawer, result["closing"])

    def test_more_coins_now_to_protect_later_exact_change(self):
        values = [1,3,4,10]
        payments = [dict(id="first", price=4, tender=[0,0,0,1]), dict(id="next", price=7, tender=[0,0,0,1])]
        result = plan(dict(denominations=values,opening=[2,2,1,0],reserve=[0]*4,payments=payments),
                      dict(denominations=values,available=[0]*4))
        self.assertTrue(result["complete"])
        self.assertEqual([s["change"] for s in result["steps"]], [[2,0,1,0],[0,1,0,0]])

    def test_cli_certifies_minimum_and_reports_block(self):
        for filename, code in [("supply",0), ("no-supply",3)]:
            run = subprocess.run([sys.executable, ROOT/"float_plan.py", ROOT/"examples/lunch.json",
                                  ROOT/f"examples/{filename}.json"], capture_output=True, text=True)
            self.assertEqual(run.returncode, code, run.stderr)
            result = json.loads(run.stdout)
            if code == 0:
                self.assertEqual((result["topUpValue"], result["piecesReturned"], result["topUp"]),
                                 (45,10,[0,1,4,0,0]))
            else:
                self.assertEqual(result["firstBlocked"], dict(id="A05-edamame",position=3,
                                 tenderMinusPrice=45,reason="no_exact_change"))

    def test_underpaid_and_invalid_inputs(self):
        shift = dict(denominations=[1], opening=[10], reserve=[1], payments=[dict(id="A",price=3,tender=[2])])
        supply = dict(denominations=[1], available=[10])
        self.assertEqual(plan(shift,supply)["firstBlocked"]["reason"], "underpaid")
        self.assertEqual(plan({**shift,"payments":[]},supply)["closing"], [10])
        for change in [dict(payments=shift["payments"]*2), dict(opening=[True]), dict(denominations=[0])]:
            with self.assertRaises(ValueError):
                plan({**shift,**change},supply)
        with self.assertRaises(ValueError):
            plan(shift,{**supply,"denominations":[2]})
