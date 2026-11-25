"""Reproduce service readiness and supplier quotes from the same example orders."""
import json
from pathlib import Path

from lunch import purchase
from prep import plan, readiness


EXAMPLES = Path(__file__).resolve().parent / "examples"
SUPPLIERS = EXAMPLES.parents[1] / "pantry-freight" / "examples" / "suppliers.json"


def purchasing(book, stock, orders):
    demand = plan(orders, book, stock)
    catalog = json.loads(SUPPLIERS.read_text(encoding="utf-8"))
    storage = dict(soy=5, kombu=3, grain=40, cutlet=0, chicken=20, eggs=0)
    unavailable = [
        dict(offer, stock=0) if offer["component"] == "chicken" else offer
        for offer in catalog["offers"]
    ]
    scenarios = [
        ("standard", catalog),
        ("storage", dict(catalog, max_surplus=storage)),
        ("stockout", dict(catalog, offers=unavailable)),
        ("pack_limit", dict(catalog, max_surplus={"chicken": 10})),
    ]
    return {
        "ingredients": [
            dict(component=row["component"], name=row["name"], unit=row["unit"],
                 quantity=row["needed"] - row["available"])
            for row in demand["lines"] if row["action"] == "purchase" and row["needed"] > row["available"]
        ],
        "cases": [
            dict(id=key, limits=offer_book.get("max_surplus", {}), result=purchase(demand, offer_book))
            for key, offer_book in scenarios
        ],
    }


def demo():
    book, stock, orders = (json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
                           for name in ("recipes.json", "stock.json", "orders.json"))
    quotes = purchasing(book, stock, orders)
    stock.update({"grain": 360, "cutlet": 3, "eggs": 5, "soy": 20, "kombu": 2})
    arrival = {"component": "chicken", "name": "雞肉", "unit": "g", "quantity": 280}
    return {"format": "prep-sheet.readiness-demo.v1", "arrival": arrival,
            "before": readiness(orders, book, stock),
            "after": readiness(orders, book, {**stock, "chicken": arrival["quantity"]}),
            "purchasing": quotes}


if __name__ == "__main__":
    print(json.dumps(demo(), ensure_ascii=False, indent=2))
