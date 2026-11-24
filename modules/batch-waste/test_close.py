from copy import deepcopy
from fractions import Fraction
import random
import unittest

from close import close


def movement(delta, balance):
    return {"delta": delta, "balance": balance, "unit": "g"}


def simple(qty1, qty2, cost1, cost2, issued):
    total = qty1 + qty2
    history = [
        {"receipt": 1, "kind": "receive", "movements": {"grain": movement(qty1, qty1)}},
        {
            "receipt": 2,
            "kind": "purchase_receive",
            "movements": {"grain": movement(qty2, total)},
        },
    ]
    if issued:
        history.append(
            {
                "receipt": 3,
                "kind": "issue",
                "movements": {"grain": movement(-issued, total - issued)},
            }
        )
    invoices = {
        "1": {"grain": {"unit": "g", "cost_cents": cost1}},
        "2": {"grain": {"unit": "g", "cost_cents": cost2}},
    }
    return history, invoices


class CloseTests(unittest.TestCase):
    def test_random_costs_match_an_independent_unit_ledger(self):
        rng = random.Random(216)
        for _ in range(300):
            qty1, qty2 = (rng.randint(1, 14) for _ in range(2))
            price1, price2 = (rng.randint(0, 91) for _ in range(2))
            issued = rng.randrange(qty1 + qty2 + 1)
            remain = qty1 + qty2 - issued
            lost = rng.randrange(remain + 1)
            discarded = rng.randrange(lost + 1)
            history, invoices = simple(qty1, qty2, price1, price2, issued)
            counts = {
                "through_receipt": len(history),
                "components": {
                    "grain": {
                        "unit": "g",
                        "discarded": discarded,
                        "quantity": remain - lost,
                    }
                },
            }
            valued = [Fraction(price1, qty1)] * qty1 + [Fraction(price2, qty2)] * qty2
            expected_issued = sum(valued[:issued])
            expected_short = sum(valued[issued : issued + lost])
            expected_end = sum(valued[issued + lost :])
            result = close(history, invoices, counts, after=1)
            self.assertEqual(result["opening_cost_cents"], price1)
            self.assertEqual(result["received_cost_cents"], price2)
            self.assertEqual(result["issued_cost_cents"], expected_issued)
            self.assertEqual(result["closing_cost_cents"], expected_end)
            self.assertEqual(
                result["discarded_cost_cents"],
                Fraction(expected_short) * discarded / lost if lost else 0,
            )
            self.assertEqual(
                result["unexplained_short_cost_cents"] + result["discarded_cost_cents"],
                expected_short,
            )

    def test_surplus_counts_leave_fifo_value_without_fabricating_price(self):
        history, invoices = simple(3, 2, 200, 250, 0)
        counts = {
            "through_receipt": 2,
            "components": {"grain": {"unit": "g", "discarded": 0, "quantity": 8}},
        }
        result = close(history, invoices, counts, 0)
        self.assertEqual(result["closing_cost_cents"], 450)
        self.assertEqual(result["counts"][0]["unvalued_surplus_quantity"], 3)
        counts["components"] = {}
        self.assertEqual(
            close(history, invoices, counts, 0)["uncounted_components"], ["grain"]
        )

    def test_nested_make_transfers_exact_cost_at_fractional_rates(self):
        history, invoices = simple(3, 2, 100, 200, 0)
        history += [
            {
                "receipt": 3,
                "kind": "make",
                "movements": {"grain": movement(-2, 3), "broth": movement(7, 7)},
            },
            {
                "receipt": 4,
                "kind": "make",
                "movements": {"broth": movement(-3, 4), "sauce": movement(9, 9)},
            },
            {"receipt": 5, "kind": "issue", "movements": {"sauce": movement(-1, 8)}},
        ]
        counts = {"through_receipt": 5, "components": {}}
        result = close(history, invoices, counts, 2)
        self.assertEqual(result["issued_cost_cents"], Fraction(200, 63))
        self.assertEqual(result["closing_cost_cents"], 300 - Fraction(200, 63))
        self.assertEqual(
            result["movements"][-1]["inputs"]["sauce"][0]["lot_receipt"], 4
        )

    def test_refuse_to_value_incomplete_inconsistent_or_stale_records(self):
        history, invoices = simple(3, 2, 100, 200, 1)
        counts = {
            "through_receipt": 3,
            "components": {"grain": {"unit": "g", "discarded": 1, "quantity": 3}},
        }
        bad_cases = [
            lambda h, i, c: h.pop(1),
            lambda h, i, c: h[1].update(receipt=3),
            lambda h, i, c: h[-1]["movements"]["grain"].update(balance=9),
            lambda h, i, c: h[-1]["movements"]["grain"].update(unit="kg"),
            lambda h, i, c: i.pop("1"),
            lambda h, i, c: i.update({"3": i["1"]}),
            lambda h, i, c: i["1"]["grain"].update(unit="kg"),
            lambda h, i, c: c["components"]["grain"].update(discarded=2),
        ]
        for change in bad_cases:
            docs = deepcopy((history, invoices, counts))
            change(*docs)
            with self.assertRaises(ValueError):
                close(*docs, after=1)
