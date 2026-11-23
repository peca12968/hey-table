"""Recover per-unit prices from a frozen Hey Table receipt."""
from collections import Counter, defaultdict

MAX_AMOUNT = 2**53 - 1


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_AMOUNT:
        raise ValueError(f"Expected an integer from {minimum} to {MAX_AMOUNT}")
    return value


def by_id(rows):
    if not isinstance(rows, list):
        raise ValueError("Expected a list")
    result = {}
    for row in rows:
        key = row["id"]
        if not isinstance(key, str) or not key.strip() or key in result:
            raise ValueError("Missing or duplicate ID")
        result[key] = row
    return result


def price_lots(ticket):
    items = by_id(ticket["items"])
    if not items:
        raise ValueError("Empty receipt")
    total = integer(ticket["total"])
    subtotal = sum(integer(i["qty"], 1) * integer(i["price"]) for i in items.values())
    remaining = {key: i["qty"] for key, i in items.items()}
    savings = Counter()
    lots = defaultdict(list)

    if "combo" in ticket:
        combo = ticket["combo"]
        if combo["version"] != "demo-v1":
            raise ValueError("Unknown combo receipt version")
        quote = combo["quote"]
        lines = by_id(quote["lines"])
        if quote["currency"] != "TWD" or items.keys() != lines.keys():
            raise ValueError("Quote and receipt describe different dishes or currency")
        mains, sides = set(), set()
        for bundle_id, b in by_id(quote["bundles"]).items():
            qty = integer(b["qty"], 1)
            main, side = b["main"], b["side"]
            mains.add(main)
            sides.add(side)
            if main in sides or side in mains or main not in items or side not in items:
                raise ValueError("Unknown or repeated dish in bundle")
            discounts = [integer(b["mainUnitDiscount"]), integer(b["sideUnitDiscount"])]
            if sum(discounts) != integer(b["unitSavings"], 1):
                raise ValueError("Bundle discount does not add up")
            retail = items[main]["price"] + items[side]["price"]
            if retail == 0 or discounts[0] != (2 * sum(discounts) * items[main]["price"] + retail) // (2 * retail):
                raise ValueError("Discount allocation differs from the demo-v1 receipt format")
            net = 0
            for dish, discount in zip((main, side), discounts):
                unit = items[dish]["price"] - discount
                remaining[dish] -= qty
                if unit < 0 or remaining[dish] < 0:
                    raise ValueError("Bundle exceeds price or quantity")
                net += unit
                savings[dish] += qty * discount
                lots[dish].append({"bundle": bundle_id, "qty": qty, "unit": unit})
            if net != integer(b["unitPrice"]):
                raise ValueError("Bundle price does not add up")
        for key, line in lines.items():
            qty, price = items[key]["qty"], items[key]["price"]
            expected = (qty, price, qty * price, qty - remaining[key], savings[key], qty * price - savings[key])
            if tuple(integer(line[k]) for k in ("qty", "price", "subtotal", "paired", "discount", "total")) != expected:
                raise ValueError("Receipt line differs from bundle allocation")
        if (integer(quote["subtotal"]), integer(quote["discount"]), integer(quote["total"])) != (subtotal, sum(savings.values()), total):
            raise ValueError("Quote totals differ from receipt")
    if subtotal - sum(savings.values()) != total:
        raise ValueError("Receipt total does not add up")

    for key, qty in remaining.items():
        if qty:
            lots[key].append({"bundle": None, "qty": qty, "unit": items[key]["price"]})
        lots[key].sort(key=lambda lot: (-lot["unit"], lot["bundle"] is not None, lot["bundle"] or ""))
    return dict(lots)


def allocate(lots, used, selection):
    if not isinstance(selection, dict) or not selection:
        raise ValueError("Choose at least one dish")
    lines = []
    for dish, quantity in sorted(selection.items()):
        needed = integer(quantity, 1)
        skipped = used[dish]
        for lot in lots.get(dish, []):
            # Exact lot usage can leave holes when a prior return is voided.
            free = lot["qty"] - used.get((dish, lot["bundle"], lot["unit"]), 0)
            already_used = min(skipped, free)
            skipped -= already_used
            take = min(needed, free - already_used)
            if take:
                lines.append({"dish": dish, **lot, "qty": take, "amount": take * lot["unit"]})
                needed -= take
            if not needed:
                break
        if needed:
            raise ValueError(f"Requested quantity exceeds remaining portions for {dish}")
    return lines
