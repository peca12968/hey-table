"""Reproduce a service-readiness forecast with and without a confirmed delivery."""
import json
from pathlib import Path

from prep import readiness


EXAMPLES = Path(__file__).resolve().parent / "examples"


def demo():
    book, stock, orders = (json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
                           for name in ("recipes.json", "stock.json", "orders.json"))
    stock.update({"grain": 360, "cutlet": 3, "eggs": 5, "soy": 20, "kombu": 2})
    arrival = {"component": "chicken", "name": "雞肉", "unit": "g", "quantity": 280}
    return {"format": "prep-sheet.readiness-demo.v1", "arrival": arrival,
            "before": readiness(orders, book, stock),
            "after": readiness(orders, book, {**stock, "chicken": arrival["quantity"]})}


if __name__ == "__main__":
    print(json.dumps(demo(), ensure_ascii=False, indent=2))
