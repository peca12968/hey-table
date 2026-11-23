from itertools import product
import json
from pathlib import Path
import random
import subprocess
import sys
import unittest

from float_plan import plan, shared_plan


ROOT = Path(__file__).resolve().parent


def shift(values, opening, payments):
    return dict(denominations=values, opening=opening, reserve=[0]*len(values), payments=payments)


def choices(values, drawer, rows):
    """Enumerate complete, independent change sequences for this one possible shift."""
    if not rows:
        yield ()
        return
    row = rows[0]
    stock = [x+y for x,y in zip(drawer,row["tender"])]
    due = sum(x*y for x,y in zip(values,row["tender"])) - row["price"]
    for change in product(*(range(min(n,due//v)+1) for n,v in zip(stock,values))):
        if sum(x*y for x,y in zip(values,change)) == due:
            for tail in choices(values,[a-b for a,b in zip(stock,change)],rows[1:]):
                yield (change, *tail)


def exhaustive_pair(values, opening, caps, left, right):
    # Combine complete sequences only if their decisions agree before the branch.
    common = 0
    for a,b in zip(left,right):
        if (a["price"],a["tender"]) != (b["price"],b["tender"]):
            break
        common += 1
    for depth in range(max(len(left),len(right)), -1, -1):
        best = None
        for extra in product(*(range(cap+1) for cap in caps)):
            drawer = [a+b for a,b in zip(opening,extra)]
            cost = sum(v*n for v,n in zip(values,extra))
            for a,b in product(choices(values,drawer,left[:depth]),choices(values,drawer,right[:depth])):
                if a[:common] == b[:common]:
                    worst = max(sum(map(sum,a)), sum(map(sum,b)))
                    score = (cost,worst)
                    if best is None or score < best:
                        best = score
        if best is not None:
            return depth, *best


class SharedFloatTests(unittest.TestCase):
    def test_same_observations_hide_future_even_if_receipt_ids_differ(self):
        # Synthetic voucher denominations. Giving 3+3 leaves no way to make 3,
        # giving 4+1+1 leaves no way to make 4 unless we top up before opening.
        values, opening = [1,3,4,10], [2,2,1,0]
        def branch(label, price):
            return shift(values,opening,[dict(id=label,price=4,tender=[0,0,0,1]),
                                         dict(id="later",price=price,tender=[0,0,0,1])])
        branches = [branch("A",7),branch("B",6)]
        empty = dict(denominations=values,available=[0]*4)
        self.assertTrue(all(plan(s,empty)["complete"] for s in branches))
        insufficient = shared_plan(branches,empty)
        self.assertEqual((insufficient["guaranteedRounds"],insufficient["firstUnsupportedRound"]), (1,2))
        result = shared_plan(branches,{**empty,"available":[1,0,0,0]})
        self.assertEqual((result["complete"],result["topUpValue"],result["worstPiecesReturned"]), (True,1,5))
        a,b = result["scenarios"]
        self.assertEqual(a["steps"][0]["change"],b["steps"][0]["change"])

    def test_96_pairs_by_independent_enumeration(self):
        rng = random.Random(3143)
        values = [1,3,4]
        for case in range(96):
            opening = [rng.randrange(3) for _ in values]
            caps = [rng.randrange(2) for _ in values]
            def payment(index):
                tender = [rng.randrange(2) for _ in values]
                return dict(id=str(index), price=rng.randrange(sum(v*n for v,n in zip(values,tender))+2),
                            tender=tender)
            left = [payment(i) for i in range(3)]
            common = rng.randrange(4)
            right = [{**row,"id":"copy-"+row["id"]} for row in left[:common]]
            right.extend(payment(i) for i in range(common,rng.randrange(common,4)))
            rows = [left,right]
            result = shared_plan([shift(values,opening,r) for r in rows], dict(denominations=values,available=caps))
            with self.subTest(case=case):
                self.assertEqual((result["guaranteedRounds"],result["topUpValue"],result["worstPiecesReturned"]),
                                 exhaustive_pair(values,opening,caps,left,right))
                seen = {}
                for inputs, scenario in zip(rows,result["scenarios"]):
                    drawer = [a+b for a,b in zip(opening,result["topUp"])]
                    prefix = ()
                    for row, step in zip(inputs[:result["guaranteedRounds"]],scenario["steps"],strict=True):
                        prefix += ((row["price"],tuple(row["tender"])),)
                        self.assertEqual(seen.setdefault(prefix,step["change"]), step["change"])
                        delta = [a-b for a,b in zip(row["tender"],step["change"])]
                        self.assertEqual(sum(v*n for v,n in zip(values,delta)),row["price"])
                        drawer = [a+b for a,b in zip(drawer,delta)]
                        self.assertTrue(all(n >= 0 for n in drawer))
                        self.assertEqual(drawer,step["drawer"])
                    self.assertEqual(drawer,scenario["closing"])

    def test_cli_lunch_alternatives_and_empty_short_shift(self):
        args = [sys.executable,ROOT/"float_plan.py",ROOT/"examples/lunch.json",ROOT/"examples/supply.json",
                "--alternative",ROOT/"examples/tea-lunch.json","--alternative",ROOT/"examples/lunch.json"]
        result = json.loads(subprocess.check_output(args))
        self.assertEqual((result["topUpValue"],result["worstPiecesReturned"]), (55,11))
        self.assertEqual(len(result["scenarios"]),3)
        self.assertEqual(result["scenarios"][0],result["scenarios"][2])
        source = shift([1],[0],[])
        with self.assertRaises(ValueError):
            shared_plan([source,{**source,"opening":[1]}],dict(denominations=[1],available=[0]))
        result = shared_plan([source,source],dict(denominations=[1],available=[4]))
        self.assertEqual((result["complete"],result["guaranteedRounds"],result["topUpValue"]), (True,0,0))
