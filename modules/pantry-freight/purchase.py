"""Choose whole grocery packs for a Prep Sheet snapshot under supplier freight rules."""
import argparse
from collections import defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import sys


def integer(value, label, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label}: expected an integer >= {minimum}")
    return value


def string(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}: expected non-empty text")
    return value


def rows(data, field):
    if not isinstance(data, dict) or not isinstance(data.get(field), list):
        raise ValueError(f"expected a list of {field}")
    for row in data[field]:
        if not isinstance(row, dict):
            raise ValueError(f"{field}: expected an object")
        yield row


@dataclass(frozen=True)
class Offer:
    sku: str
    supplier: str
    component: str
    pack: int
    price: int
    stock: int


def inputs(plan, catalog):
    needs, units, touched = {}, {}, set()
    for row in rows(plan,"lines"):
        key = string(row.get("component"),"component")
        if key in touched or row.get("action") not in ("prepare","purchase"):
            raise ValueError(f"{key}: duplicate component or unknown action")
        touched.add(key)
        if row["action"]=="purchase":
            units[key] = string(row.get("unit"),"unit")
            gap = integer(row.get("needed"),"needed") - integer(row.get("available"),"available")
            if gap > 0:
                needs[key] = gap
    if not isinstance(catalog,dict) or catalog.get("currency")!="TWD":
        raise ValueError("expected TWD catalog")
    suppliers = {}
    for row in rows(catalog,"suppliers"):
        name = string(row.get("id"),"supplier id")
        if name in suppliers:
            raise ValueError(f"{name}: duplicate supplier")
        fee = integer(row.get("shipping"),"shipping")
        threshold = row.get("free_at")
        if threshold is not None:
            integer(threshold,"free_at")
        suppliers[name] = (fee,threshold)
    offers, skus = [], set()
    for row in rows(catalog,"offers"):
        sku = string(row.get("sku"),"sku")
        supplier = string(row.get("supplier"),"supplier")
        key = string(row.get("component"),"component")
        if sku in skus or supplier not in suppliers:
            raise ValueError(f"{sku}: duplicate SKU or unknown supplier")
        skus.add(sku)
        unit = string(row.get("unit"),"unit")
        if key in units and unit != units[key]:
            raise ValueError(f"{sku}: unit differs from Prep Sheet")
        offer = Offer(sku,supplier,key,integer(row.get("pack"),"pack",1),
                      integer(row.get("price"),"price",1),integer(row.get("stock"),"stock"))
        if key in needs and offer.stock:
            offers.append(offer)
    limits = catalog.get("max_surplus", {})
    if not isinstance(limits, dict):
        raise ValueError("max_surplus must map component IDs to quantities")
    for key,value in limits.items():
        integer(value,f"max_surplus for {key}")
    return needs,units,suppliers,sorted(offers,key=lambda o:o.sku),limits


def shipping(rule, spent):
    fee,threshold = rule
    return fee if spent and (threshold is None or spent<threshold) else 0


def ceildiv(n, d):
    return (n+d-1)//d


def optimize(needs, suppliers, offers, limits):
    vendors = sorted({o.supplier for o in offers})
    indexes = {name:i for i,name in enumerate(vendors)}
    by_item = defaultdict(list)
    for i,offer in enumerate(offers):
        by_item[offer.component].append((i,offer))
    # Frontier value: subtotal, number of packs, and the SKU-count tie breaker.
    frontier = {(0,)*len(vendors):(0,0,(0,)*len(offers))}
    for key,gap in sorted(needs.items()):
        maximum = gap+limits[key] if key in limits else None
        states = {(credit,0):value for credit,value in frontier.items()}
        for i,o in by_item[key]:
            j = indexes[o.supplier]
            fee,threshold = suppliers[o.supplier]
            # With a flat fee only "used" matters. A zero-fee vendor needs no state.
            cap = (1 if threshold is None else threshold) if fee else 0
            limit = min(o.stock,max(ceildiv(gap,o.pack),ceildiv(cap,o.price)))
            block = 1
            while limit:
                qty = min(block,limit)
                limit -= qty
                block *= 2
                updated = states.copy()
                for (credit,covered),(cost,packs,counts) in states.items():
                    quantity = covered+qty*o.pack
                    if maximum is not None and quantity>maximum:
                        continue
                    new_credit = credit[:j] + (min(cap,credit[j]+qty*o.price),) + credit[j+1:]
                    dest = (new_credit,quantity if maximum is not None else min(gap,quantity))
                    new_counts = counts[:i] + (counts[i]+qty,) + counts[i+1:]
                    value = (cost+qty*o.price,packs+qty,new_counts)
                    if dest not in updated or value < updated[dest]:
                        updated[dest] = value
                states = updated
        frontier = {}
        for (credit,covered),value in states.items():
            if covered>=gap and (credit not in frontier or value<frontier[credit]):
                frontier[credit]=value
        if not frontier:
            return None,key
    def final(entry):
        credit,(cost,packs,counts) = entry
        freight = sum(shipping(suppliers[v],c) for v,c in zip(vendors,credit))
        return cost+freight,packs,counts
    return min(map(final,frontier.items()))[2],None


def purchase(plan, catalog):
    needs,units,suppliers,offers,limits = inputs(plan,catalog)
    capacity = defaultdict(int)
    for o in offers:
        capacity[o.component] += o.pack*o.stock
    shortages = [{"component":k,"unit":units[k],"required":n,"offered":capacity[k],"uncovered":n-capacity[k]}
                 for k,n in sorted(needs.items()) if capacity[k]<n]
    if shortages:
        return {"status":"infeasible","shortages":shortages}
    counts,blocked = optimize(needs,suppliers,offers,limits)
    if blocked is not None:
        return {"status":"infeasible","pack_limit":{"component":blocked,"unit":units[blocked],
                "required":needs[blocked],"max_purchase":needs[blocked]+limits[blocked]}}
    loads = defaultdict(list)
    received = defaultdict(int)
    for o,count in zip(offers,counts):
        if count:
            loads[o.supplier].append({"sku":o.sku,"component":o.component,"packs":count,"pack":o.pack,
                                      "unit":units[o.component],"unit_price_twd":o.price,"cost_twd":count*o.price})
            received[o.component] += o.pack*count
    orders = []
    for vendor,lines in sorted(loads.items()):
        amount = sum(row["cost_twd"] for row in lines)
        fee = shipping(suppliers[vendor],amount)
        orders.append({"supplier":vendor,"lines":lines,"subtotal_twd":amount,"shipping_twd":fee,"total_twd":amount+fee})
    return {"status":"ok","currency":"TWD","orders":orders,"total_twd":sum(o["total_twd"] for o in orders),
            "shipping_twd":sum(o["shipping_twd"] for o in orders),"packs":sum(counts),
            "ingredients":[{"component":k,"shortfall":needs[k],"purchased":n,"surplus":n-needs[k],"unit":units[k]}
                           for k,n in sorted(received.items())],"quantities":dict(received)}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan",type=Path)
    parser.add_argument("catalog",type=Path)
    parser.add_argument("--format",choices=["report","quantities"],default="report")
    args = parser.parse_args(argv)
    try:
        report = purchase(read_json(args.plan),read_json(args.catalog))
    except (ValueError,OSError) as exc:
        print(str(exc),file=sys.stderr)
        return 2
    if report["status"]=="infeasible" and args.format=="quantities":
        print(json.dumps(report,ensure_ascii=False),file=sys.stderr)
        return 3
    result = report.get("quantities") if args.format=="quantities" else report
    print(json.dumps(result,ensure_ascii=False,indent=2,sort_keys=True))
    return 0 if report["status"]=="ok" else 3


if __name__=="__main__":
    sys.exit(main())
