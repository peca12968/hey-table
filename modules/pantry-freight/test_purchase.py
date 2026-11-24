from copy import deepcopy
from itertools import product
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

from purchase import purchase, read_json

ROOT=Path(__file__).resolve().parent
PLAN=read_json(ROOT/"examples/lunch.json")
CAT=read_json(ROOT/"examples/suppliers.json")


def brute_force(gaps,catalog):
    # Enumerate physical baskets, without truncating stock, credit or overfill.
    offers=sorted(catalog["offers"], key=lambda o:o["sku"])
    best=None
    for counts in product(*(range(o["stock"]+1) for o in offers)):
        bought={k:0 for k in gaps}
        invoices={}
        for o,count in zip(offers,counts):
            bought[o["component"]]+=count*o["pack"]
            if count:
                vendor=o["supplier"]
                invoices[vendor]=invoices.get(vendor,0)+count*o["price"]
        if any(n<gaps[k] or (k in catalog["max_surplus"] and n-gaps[k]>catalog["max_surplus"][k])
               for k,n in bought.items()):
            continue
        total=sum(invoices.values())
        for v in catalog["suppliers"]:
            if v["id"] in invoices and (v["free_at"] is None or invoices[v["id"]]<v["free_at"]):
                total+=v["shipping"]
        score=(total,sum(counts),counts)
        if best is None or score<best:
            best=score
    return best


class PurchaseTests(unittest.TestCase):
    def test_lunch_with_and_without_storage_limits(self):
        report=purchase(PLAN,CAT)
        self.assertEqual((report["total_twd"],report["shipping_twd"],report["packs"]),(165,0,7))
        self.assertEqual(report["quantities"],dict(soy=50,kombu=5,grain=400,cutlet=2,chicken=300,eggs=3))
        restricted=dict(CAT,max_surplus=dict(soy=5,kombu=3,grain=40,cutlet=0,chicken=20,eggs=0))
        limited=purchase(PLAN,restricted)
        self.assertEqual((limited["orders"][0]["supplier"],limited["total_twd"],limited["packs"]),("depot",170,6))
        impossible=purchase(PLAN,dict(CAT,max_surplus={"chicken":10}))
        self.assertEqual(impossible["pack_limit"],dict(component="chicken",unit="g",required=280,max_purchase=290))

    def test_320_catalogs_against_every_bounded_basket(self):
        rng=random.Random(19874)
        for case in range(320):
            gaps={"x":rng.randint(1,6),"y":rng.randint(1,6)}
            lines=[dict(action="purchase",component=k,needed=n+1,available=1,unit="g") for k,n in gaps.items()]
            vendors=[dict(id=v,shipping=rng.randrange(9),free_at=rng.choice([None,0,5,10,15])) for v in ["a","b"]]
            offers=[dict(sku=str(i),supplier=rng.choice(["a","b"]),component=k,pack=rng.randint(1,4),
                         stock=rng.randint(0,3),price=rng.randint(1,7),unit="g") for i,k in enumerate("xyxy")]
            caps={k:rng.randrange(5) for k in gaps if rng.randrange(2)}
            catalog=dict(currency="TWD",suppliers=vendors,offers=offers,max_surplus=caps)
            expected=brute_force(gaps,catalog)
            actual=purchase({"lines":lines},catalog)
            if expected is None:
                self.assertEqual(actual["status"],"infeasible",case)
            else:
                quantities={l["sku"]:l["packs"] for v in actual["orders"] for l in v["lines"]}
                self.assertEqual((actual["total_twd"],actual["packs"],tuple(quantities.get(str(i),0) for i in range(4))),
                                 expected,case)
            rng.shuffle(offers)
            self.assertEqual(purchase({"lines":lines[::-1]},catalog),actual)

    def test_empty_plan_and_infeasible_are_distinct(self):
        r=purchase({"lines":[]},CAT)
        self.assertEqual((r["status"],r["total_twd"],r["quantities"]),("ok",0,{}))
        r=purchase(PLAN,dict(CAT,offers=[]))
        self.assertEqual(r["status"],"infeasible")
        self.assertEqual({row["component"] for row in r["shortages"]},{"soy","chicken","eggs","grain","kombu","cutlet"})
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"unavailable.json"
            path.write_text(json.dumps(dict(CAT,offers=[])),encoding="utf8")
            cli=subprocess.run([sys.executable,ROOT/"purchase.py",ROOT/"examples/lunch.json",path,"--format","quantities"],
                               capture_output=True)
            self.assertEqual((cli.returncode,cli.stdout),(3,b""))

    def test_mixing_limited_suppliers_and_filling_a_threshold_with_multiple_extra_packs(self):
        line=dict(action="purchase",component="chicken",unit="g",needed=650,available=0)
        offers=[dict(sku=v,component="chicken",supplier=v,unit="g",pack=300,price=n,stock=s)
                for v,n,s in [("a",10,2),("b",20,2)]]
        catalog=dict(currency="TWD",suppliers=[dict(id="a",shipping=5),dict(id="b",shipping=9)],offers=offers)
        result=purchase({"lines":[line]},catalog)
        self.assertEqual([(v["supplier"],v["lines"][0]["packs"]) for v in result["orders"]],[("a",2),("b",1)])
        self.assertEqual((result["shipping_twd"],result["total_twd"]),(14,54))
        catalog["suppliers"]=[dict(id="a",shipping=100,free_at=70)]
        catalog["offers"]=[dict(offers[0],stock=100000)]
        result=purchase({"lines":[dict(line,needed=1)]},catalog)
        self.assertEqual((result["packs"],result["total_twd"]),(7,70))

    def test_input_errors_and_integer_precision(self):
        for key,wrong in [("price",1.5),("price",True),("unit","lb"),("stock",-1),("supplier","unknown")]:
            c=deepcopy(CAT)
            c["offers"][0][key]=wrong
            with self.assertRaises(ValueError):
                purchase(PLAN,c)
        line={"component":"x","action":"purchase","needed":1,"available":0,"unit":"g"}
        high=2**53+123
        c=dict(currency="TWD",suppliers=[dict(id="v",shipping=1)],offers=[
            dict(sku="x",supplier="v",component="x",pack=1,stock=10**12,price=high,unit="g")])
        self.assertEqual(purchase({"lines":[line]},c)["total_twd"],high+1)
        with self.assertRaises(ValueError):
            purchase({"lines":[line,line]},c)


if __name__=="__main__":
    unittest.main()
