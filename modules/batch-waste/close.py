"""Close Prep Sheet inventory at FIFO cost using posted movements, invoices and counts."""

import argparse
from collections import defaultdict, deque
from dataclasses import dataclass
from fractions import Fraction
import json
from pathlib import Path
import sys


def integer(value, label, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(f"{label}: expected an integer >= {minimum}")
    return value


def obj(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label}: expected an object")
    return value


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}: expected text")
    return value


@dataclass
class Lot:
    receipt: int
    quantity: int
    rate: Fraction


class Inventory:
    def __init__(self):
        self.units = {}
        self.quantities = defaultdict(int)
        self.lots = defaultdict(deque)

    def add(self, part, receipt, qty, cost):
        self.quantities[part] += qty
        self.lots[part].append(Lot(receipt, qty, cost / qty))

    def take(self, part, qty):
        if qty > self.quantities[part]:
            raise ValueError(f"{part}: units exceed recorded stock")
        self.quantities[part] -= qty
        queue = self.lots[part]
        shares = []
        while qty:
            lot = queue[0]
            used = min(qty, lot.quantity)
            shares.append(
                {
                    "lot_receipt": lot.receipt,
                    "quantity": used,
                    "cost_cents": lot.rate * used,
                }
            )
            lot.quantity -= used
            qty -= used
            if not lot.quantity:
                queue.popleft()
        return shares

    def value(self):
        return sum(
            (lot.quantity * lot.rate for queue in self.lots.values() for lot in queue),
            Fraction(),
        )

    def movements(self, raw):
        result = {}
        for part, movement in obj(raw, "movements").items():
            text(part, "component")
            unit = text(movement["unit"], "unit")
            delta = movement["delta"]
            if type(delta) is not int or not delta:
                raise ValueError(f"{part}: expected a nonzero integer movement")
            if self.units.setdefault(part, unit) != unit:
                raise ValueError(f"{part}: unit changed in history")
            balance = integer(movement["balance"], "balance")
            if self.quantities[part] + delta != balance:
                raise ValueError(f"{part}: movement does not match its posted balance")
            result[part] = delta
        return result


def cost_of(shares):
    return sum((share["cost_cents"] for share in shares), Fraction())


def post(stock, entry, invoice):
    number = entry["receipt"]
    kind = entry["kind"]
    movements = stock.movements(entry["movements"])
    added = {part: qty for part, qty in movements.items() if qty > 0}
    removed = {part: -qty for part, qty in movements.items() if qty < 0}
    if kind in ("receive", "purchase_receive"):
        prices = obj(invoice, f"invoice {number}")
        if removed or not added or prices.keys() != added.keys():
            raise ValueError(
                f"receipt {number}: invoice must cover each received component exactly"
            )
        cost = Fraction()
        for part, qty in added.items():
            line = prices[part]
            if line["unit"] != stock.units[part]:
                raise ValueError(
                    f"receipt {number}: invoice and ledger units differ for {part}"
                )
            price = Fraction(integer(line["cost_cents"], "cost_cents"))
            stock.add(part, number, qty, price)
            cost += price
        return {"receipt": number, "kind": kind, "cost_cents": cost}

    if kind == "make":
        valid = len(added) == 1 and bool(removed)
    elif kind == "issue":
        valid = not added and bool(removed)
    else:
        raise ValueError(f"unsupported movement kind {kind}")
    if not valid:
        raise ValueError(f"receipt {number}: invalid make or issue movement")
    inputs = {part: stock.take(part, qty) for part, qty in sorted(removed.items())}
    cost = sum((cost_of(lots) for lots in inputs.values()), Fraction())
    detail = {"receipt": number, "kind": kind, "cost_cents": cost, "inputs": inputs}
    if kind == "make":
        ((part, qty),) = added.items()
        stock.add(part, number, qty, cost)
        detail["produced"] = {"component": part, "quantity": qty}
    return detail


def count(stock, counts):
    adjustments = []
    for part, line in sorted(obj(counts, "components counted").items()):
        if part not in stock.units or stock.units[part] != line["unit"]:
            raise ValueError(f"{part}: count outside the ledger or in a different unit")
        expected = stock.quantities[part]
        measured = integer(line["quantity"], "counted quantity")
        discard = integer(line["discarded"], "discarded quantity")
        shortfall = max(0, expected - measured)
        if discard > shortfall:
            raise ValueError(f"{part}: documented discard exceeds the shortage")
        shortage_lots = stock.take(part, shortfall)
        # Take the shortage from FIFO once. Assign its average cost proportionally,
        # because the count cannot identify which missing units were discarded.
        cost = cost_of(shortage_lots)
        documented = cost * discard / shortfall if shortfall else Fraction()
        adjustments.append(
            {
                "component": part,
                "unit": stock.units[part],
                "book_quantity": expected,
                "counted_quantity": measured,
                "discarded_quantity": discard,
                "unexplained_short_quantity": shortfall - discard,
                "unvalued_surplus_quantity": max(0, measured - expected),
                "discarded_cost_cents": documented,
                "unexplained_short_cost_cents": cost - documented,
                "shortage_lots": shortage_lots,
            }
        )
    return adjustments


def close(history, invoices, counts, after):
    if not isinstance(history, list):
        raise ValueError("expected ordered Prep Sheet history")
    integer(after, "opening receipt", 0)
    end = integer(counts["through_receipt"], "closing receipt", after)
    if end != len(history):
        raise ValueError(
            "physical counts must identify the last receipt in this history"
        )
    invoices = obj(invoices, "invoices")
    invoice_ids = set()
    inventory = Inventory()
    opening = Fraction()
    period = []
    for receipt, entry in enumerate(history, 1):
        if integer(entry["receipt"], "receipt", 1) != receipt:
            raise ValueError(
                "history must start at receipt 1 with no gaps or reordering"
            )
        ref = str(receipt)
        if entry["kind"] in ("receive", "purchase_receive"):
            invoice_ids.add(ref)
        detail = post(inventory, entry, invoices.get(ref))
        if receipt == after:
            opening = inventory.value()
        if receipt > after:
            period.append(detail)
    if invoices.keys() != invoice_ids:
        raise ValueError("invoice references do not match the inbound receipts")
    adjustments = count(inventory, counts["components"])
    received = sum(
        (
            r["cost_cents"]
            for r in period
            if r["kind"] in ("receive", "purchase_receive")
        ),
        Fraction(),
    )
    issued = sum((r["cost_cents"] for r in period if r["kind"] == "issue"), Fraction())
    discarded = sum((r["discarded_cost_cents"] for r in adjustments), Fraction())
    unexplained = sum(
        (r["unexplained_short_cost_cents"] for r in adjustments), Fraction()
    )
    closing = inventory.value()
    assert opening + received == issued + discarded + unexplained + closing
    return {
        "after_receipt": after,
        "through_receipt": end,
        "opening_cost_cents": opening,
        "received_cost_cents": received,
        "issued_cost_cents": issued,
        "discarded_cost_cents": discarded,
        "unexplained_short_cost_cents": unexplained,
        "closing_cost_cents": closing,
        "movements": period,
        "counts": adjustments,
        "uncounted_components": sorted(
            p
            for p, qty in inventory.quantities.items()
            if qty and p not in counts["components"]
        ),
        "ending_lots": [
            {
                "component": part,
                "lot_receipt": lot.receipt,
                "quantity": lot.quantity,
                "cost_cents": lot.rate * lot.quantity,
            }
            for part, queue in sorted(inventory.lots.items())
            for lot in queue
        ],
    }


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON field {key}")
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history", type=Path)
    parser.add_argument("invoices", type=Path)
    parser.add_argument("counts", type=Path)
    parser.add_argument(
        "--after", type=int, default=0, help="last receipt before this shift"
    )
    args = parser.parse_args()
    try:
        data = (
            json.loads(p.read_text(encoding="utf-8-sig"), object_pairs_hook=unique)
            for p in (args.history, args.invoices, args.counts)
        )
        result = close(*data, args.after)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, default=str, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
