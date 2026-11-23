"""Allocate cumulative return credits against the whole TWD originally paid for each dish."""
from collections import Counter
from fractions import Fraction
from heapq import heapify, heappop, heappush

from pricing import integer


def verify_split(document, lots, total):
    if not isinstance(document, dict) or integer(document["total"]) != total:
        raise ValueError("Split total differs from receipt")
    lines, diners = document["lines"], document["diners"]
    if not isinstance(lines, dict) or lines.keys() != lots.keys() or not isinstance(diners, dict):
        raise ValueError("Split must cover the receipt dishes and diners")
    totals = Counter()
    for dish, portions in lots.items():
        paid = lines[dish]
        if not isinstance(paid, dict) or not paid:
            raise ValueError(f"Missing paid shares for {dish}")
        for person, value in paid.items():
            if not isinstance(person, str) or not person.strip():
                raise ValueError("Missing diner name")
            totals[person] += integer(value)
        if sum(paid.values()) != sum(p["unit"] * p["qty"] for p in portions):
            raise ValueError(f"Paid shares differ from receipt for {dish}")
    if diners.keys() != totals.keys() or any(integer(diners[p]["pay"]) != v for p, v in totals.items()):
        raise ValueError("Diner totals differ from paid dish shares")
    return lines


def allocate_credit(paid, credit):
    total = sum(paid.values())
    if not 0 <= credit <= total:
        raise ValueError("Credit exceeds paid dish amount")
    if credit == total:
        return paid.copy()
    # Each guaranteed prefix uses quotients at least total / credit. Fewer
    # than one residual unit per diner remains for the exact priority queue.
    amounts = {person: credit * value // total for person, value in paid.items()}
    queue = [(-Fraction(value, amounts[person]+1), person) for person, value in paid.items() if value]
    heapify(queue)
    for _ in range(credit - sum(amounts.values())):
        _, person = heappop(queue)
        amounts[person] += 1
        heappush(queue, (-Fraction(paid[person], amounts[person]+1), person))
    return amounts


def credit_report(rid, lines, used):
    refunded = Counter()
    for (dish, _, unit), qty in used.items():
        refunded[dish] += unit * qty
    diners = {}
    dishes = {}
    for dish, paid in lines.items():
        credit = allocate_credit(paid, refunded[dish])
        dishes[dish] = {"paid": paid, "credit": credit, "totalCredit": refunded[dish]}
        for person, payment in paid.items():
            row = diners.setdefault(person, {"paid": 0, "credit": 0, "remaining": 0})
            row["paid"] += payment
            row["credit"] += credit[person]
            row["remaining"] += payment - credit[person]
    return {"receipt": rid, "totalPaid": sum(r["paid"] for r in diners.values()),
            "totalCredit": sum(refunded.values()), "diners": diners, "dishes": dishes}
