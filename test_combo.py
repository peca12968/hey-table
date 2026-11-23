from copy import deepcopy
import json
import os
from pathlib import Path
from random import Random
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from split import split_quote
from test_split import ROOT, oracle


def node(script, cases, *args):
    command = ["node", "--input-type=module", "-e", script, *map(str, args)]
    result = subprocess.run(command, cwd=ROOT, input=json.dumps(cases), capture_output=True,
                            encoding="utf-8", check=True)
    return json.loads(result.stdout)


def example(name):
    return json.loads((ROOT / "examples" / (name + ".json")).read_text(encoding="utf-8"))


def check_net_quotas(quote, shares, result):
    # The oracle enumerates integer allocations from the final line amounts.
    receipt = {"total": quote["total"], "items": [
        {"id": row["id"], "price": row["total"], "qty": 1} for row in quote["lines"]]}
    oracle(receipt, shares, result)


class ComboTests(unittest.TestCase):
    def test_partially_discounted_shared_dish_and_cli(self):
        quote, shares = example("combo-quote"), example("combo-shares")
        result = split_quote(quote, shares)
        self.assertEqual(result["total"], 345)
        self.assertEqual(result["lines"]["gyoza"], {"小安": 79, "小岑": 78})
        self.assertEqual(result["diners"], {"小安": {"exact": "443/2", "pay": 222},
                                            "小岑": {"exact": "247/2", "pay": 123}})
        check_net_quotas(quote, shares, result)
        cmd = [sys.executable, ROOT/"split.py", "--combo", ROOT/"examples/combo-quote.json",
               ROOT/"examples/combo-shares.json"]
        output = subprocess.check_output(cmd, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(json.loads(output), result)
        reversed_quote = dict(quote, lines=quote["lines"][::-1], bundles=quote["bundles"][::-1])
        self.assertEqual(split_quote(reversed_quote, shares), result)
        self.assertEqual(node("""
            import {splitQuote} from "./split.mjs";
            import {readFileSync} from "node:fs";
            console.log(JSON.stringify(splitQuote(...JSON.parse(readFileSync(0, "utf8")))));
        """, [reversed_quote, shares]), result)

    def test_quote_reconciliation_rejects_conflicting_components_in_both_languages(self):
        quote, shares = example("combo-quote"), example("combo-shares")
        bad = []
        for field, value in [("total", 346), ("subtotal", 384), ("discount", 39), ("currency", "USD")]:
            bad.append(dict(quote, **{field: value}))
        for field, value in [("qty", 1), ("price", 84), ("subtotal", 169), ("discount", 12),
                             ("total", 156), ("paired", 2), ("discount", True)]:
            changed = deepcopy(quote)
            changed["lines"][0][field] = value
            bad.append(changed)
        for field, value in [("qty", 2), ("unitPrice", 214), ("unitSavings", 39), ("main", "unknown"),
                             ("mainUnitDiscount", 28), ("sideUnitDiscount", 12)]:
            changed = deepcopy(quote)
            changed["bundles"][0][field] = value
            bad.append(changed)
        bad.extend([dict(quote, lines=quote["lines"]*2), dict(quote, bundles=quote["bundles"]*2),
                    dict(quote, bundles=[])])
        # Every total still balances, but one dollar of discount was shifted to the wrong dish.
        shifted = deepcopy(quote)
        shifted["bundles"][0].update(mainUnitDiscount=26, sideUnitDiscount=14)
        for line in shifted["lines"]:
            change = {"gyoza": 1, "oyakodon": -1}.get(line["id"], 0)
            line["discount"] += change
            line["total"] -= change
        bad.append(shifted)
        cases = [(q, shares) for q in bad] + [(quote, {"ghost": {"A": 1}})]
        for q, weights in cases:
            with self.subTest(q=q), self.assertRaises((ValueError, TypeError, KeyError)):
                split_quote(q, weights)
        rejected = node("""
            import {splitQuote} from "./split.mjs";
            import {readFileSync} from "node:fs";
            console.log(JSON.stringify(JSON.parse(readFileSync(0,"utf8")).map(([q,s]) => {
              try {splitQuote(q,s); return false;} catch {return true;}
            })));
        """, cases)
        self.assertEqual(rejected, [True]*len(cases))
        with TemporaryDirectory() as tmp:
            path = Path(tmp)/"bad.json"
            path.write_text(json.dumps(shifted), encoding="utf-8")
            result = subprocess.run([sys.executable, ROOT/"split.py", "--combo", path, ROOT/"examples/combo-shares.json"],
                                    capture_output=True)
            self.assertEqual((result.returncode, result.stdout), (2, b""))

    def test_safe_integer_boundary_for_proportional_discount_products(self):
        high = 2**53 - 1
        quote = {"currency": "TWD", "subtotal": high, "discount": high - 1, "total": 1,
                 "lines": [{"id": "main", "qty": 1, "price": high - 2, "subtotal": high - 2,
                            "discount": high - 3, "total": 1, "paired": 1},
                           {"id": "side", "qty": 1, "price": 2, "subtotal": 2,
                            "discount": 2, "total": 0, "paired": 1}],
                 "bundles": [{"id": "set", "main": "main", "side": "side", "qty": 1, "unitPrice": 1,
                              "unitSavings": high - 1, "mainUnitDiscount": high - 3, "sideUnitDiscount": 2}]}
        shares = {"main": {"A": 1}, "side": {"B": 1}}
        result = split_quote(quote, shares)
        self.assertEqual(result["lines"], {"main": {"A": 1}, "side": {"B": 0}})
        self.assertEqual(node("""
            import {splitQuote} from "./split.mjs";
            import {readFileSync} from "node:fs";
            console.log(JSON.stringify(splitQuote(...JSON.parse(readFileSync(0, "utf8")))));
        """, [quote, shares]), result)

    def test_empty_cart(self):
        quote = {"currency":"TWD", "total":0, "subtotal":0, "discount":0, "lines":[], "bundles":[]}
        self.assertEqual(split_quote(quote, {}), {"total":0,"lines":{},"diners":{}})

    def test_real_combo_counter_quotes_match_exhaustive_net_shares(self):
        project = Path(os.environ.get("COMBO_PROJECT", ROOT.parent/"combo-counter")).resolve()
        if not (project/"quote.mjs").is_file() and "COMBO_PROJECT" not in os.environ:
            self.skipTest("Set COMBO_PROJECT to the Combo Counter checkout for cross-project verification")
        rng = Random(66155)
        cases = []
        for _ in range(256):
            menu = [{"id": d, "price": rng.randint(0, 95)} for d in ("m", "n", "s", "t")]
            rules = [{"id": "r"+str(i), "main": rng.choice("mn"), "side": rng.choice("st"),
                      "price": rng.randint(0, 100), "limit": rng.randint(0, 3)} for i in range(5)]
            items = [{"id": d["id"], "qty": rng.randint(1, 3)} for d in menu]
            shares = {r["id"]: {p: rng.randint(1, 3) for p in rng.sample(list("ABC"), rng.randint(1, 3))}
                      for r in items}
            cases.append([menu, rules, items, shares])
        # Include a genuine zero-net line with a nonempty set of diners.
        cases.append([[{"id":"m","price":5},{"id":"s","price":7}],
                      [{"id":"gift","main":"m","side":"s","price":0}],
                      [{"id":"m","qty":1},{"id":"s","qty":1}], {"m":{"A":1},"s":{"B":2}}])
        results = node("""
            import {readFileSync} from "node:fs";
            import {pathToFileURL} from "node:url";
            import {splitQuote} from "./split.mjs";
            const {quoteCombos} = await import(pathToFileURL(process.argv[1]));
            const cases = JSON.parse(readFileSync(0, "utf8"));
            console.log(JSON.stringify(cases.map(([menu,rules,cart,shares]) => {
              const quote = quoteCombos(menu,rules,cart);
              return [quote, splitQuote(quote,shares)];
            })));
        """, cases, project/"quote.mjs")
        self.assertEqual(len(results), len(cases))
        for index, ((quote, js), (_, _, _, shares)) in enumerate(zip(results, cases)):
            with self.subTest(index=index):
                result = split_quote(quote, shares)
                self.assertEqual(result, js)
                check_net_quotas(quote, shares, result)
        self.assertEqual(results[-1][1]["diners"]["A"], {"exact":"0","pay":0})
