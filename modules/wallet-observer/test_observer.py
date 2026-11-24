from itertools import product
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing

from observer import FORMAT, METHODS, analyze, capture


def attempt(state="pending", **changes):
    return dict(
        {
            "id": 1,
            "order": 1,
            "created": 0,
            "environment": "demo",
            "method": "line_pay",
            "state": state,
        },
        **changes,
    )


def snapshot(lo, hi, *rows):
    return {
        "format": FORMAT,
        "earliest_ms": lo,
        "latest_ms": hi,
        "attempts": list(rows),
    }


def group(docs):
    return analyze(docs, 2, "demo")["by_method"]["line_pay"]


class ObserverTests(unittest.TestCase):
    def test_another_order_dates_a_wide_observation_window(self):
        other = attempt(id=2, order=2, created=2100, method="card")
        wide = snapshot(1900, 2300, attempt(), other)
        docs = [wide, wide, snapshot(4000, 4000, attempt("paid"), other)]
        self.assertEqual(group(docs)["missed"], 1)

    def test_absent_attempt_can_commit_later_and_cohort_uses_original_start(self):
        docs = [
            snapshot(2100, 2150, attempt("failed")),
            snapshot(
                5000,
                5000,
                attempt("failed"),
                attempt("paid", id=2, created=1600),
                attempt("paid", id=3, order=2, created=2000),
            ),
        ]
        self.assertEqual(group(docs)["missed"], 1)
        result = analyze(docs, 2, "demo", 0, 2000)["by_method"]["line_pay"]
        self.assertEqual(
            (result["orders"], result["attempts"], result["missed"]), (1, 2, 1)
        )
        result = analyze(docs, 2, "demo", 2000, 5000)["by_method"]["line_pay"]
        self.assertEqual((result["orders"], result["uncertain"]), (1, 1))

    def test_bounds_match_enumerated_payment_and_capture_instants(self):
        # Each ms has two possible orderings for events on the same clock tick.
        # Enumerate possible payment times and the actual instant in each read window.
        windows = [(0, 0), (1000, 1250), (2000, 2000), (2400, 2700), (3500, 3500)]
        possible = {}
        for paid_at in range(0, 7004):
            readings = []
            for lo, hi in windows:
                readings.append({paid_at <= time for time in (2 * lo, 2 * hi + 1)})
            for seen in product(*readings):
                possible.setdefault(seen, set()).add(int(paid_at // 2 <= 2000))
        self.assertTrue(any(len(outcomes) == 2 for outcomes in possible.values()))
        for seen, outcomes in possible.items():
            docs = [
                snapshot(lo, hi, attempt("paid" if paid else "pending"))
                for paid, (lo, hi) in zip(seen, windows)
            ]
            self.assertEqual(
                group(docs)["on_time_count_range"], [min(outcomes), max(outcomes)], seen
            )

    def test_prior_authorization_is_not_paid_and_refund_preserves_paid_evidence(self):
        for state in ["paid", "partial", "refunded"]:
            docs = [
                snapshot(900, 1100, attempt("authorized")),
                snapshot(1800, 1999, attempt(state)),
                snapshot(3000, 3200, attempt("refunded")),
            ]
            self.assertEqual(group(docs)["certain"], 1)
            self.assertEqual(group([docs[0], docs[0], *docs[1:]]), group(docs))
        docs = [
            snapshot(2001, 2100, attempt("authorized")),
            snapshot(3000, 3001, attempt("refunded")),
        ]
        self.assertEqual(group(docs)["missed"], 1)
        self.assertEqual(group([snapshot(1999, 2000, attempt("paid"))])["immature"], 1)

    def test_seven_online_methods_and_independent_environments(self):
        rows = [
            attempt("paid", id=i, order=i, method=m)
            for i, m in enumerate(sorted(METHODS), 1)
        ]
        rows += [attempt("failed", id=10, order=10, environment="sandbox")]
        docs = [snapshot(1000, 1100, *rows), snapshot(4000, 4001, *rows)]
        demo = analyze(docs, 2, "demo")["by_method"]
        self.assertEqual(len(demo), 7)
        self.assertTrue(all(g["certain"] == g["eligible"] == 1 for g in demo.values()))
        self.assertEqual(
            analyze(docs, 2, "sandbox")["by_method"]["line_pay"]["missed"], 1
        )
        self.assertEqual(analyze(docs, 2, "production")["by_method"], {})

    def test_reject_incompatible_payment_histories(self):
        initial = snapshot(1000, 1050, attempt())
        for later in [
            snapshot(1040, 1100, attempt()),
            snapshot(1200, 1200),
            snapshot(1200, 1200, attempt(method="card")),
            snapshot(1200, 1200, attempt(), attempt(id=2, created=100)),
            snapshot(1200, 1200, attempt(), attempt(id=2, created=1100)),
            snapshot(1200, 1200, attempt("failed"), attempt(id=2, created=1300)),
            snapshot(1200, 1200, attempt(), attempt()),
        ]:
            with self.subTest(later=later), self.assertRaises(ValueError):
                group([initial, later])
        with self.assertRaises(ValueError):
            group(
                [
                    snapshot(1000, 1010, attempt("paid")),
                    snapshot(3000, 3010, attempt("pending")),
                ]
            )

    def test_readonly_projection_excludes_lookup_times_and_personal_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sample.db"
            with self.assertRaises(sqlite3.OperationalError):
                capture(path)
            self.assertFalse(path.exists())
            with closing(sqlite3.connect(path)) as db:
                db.executescript("""
                    CREATE TABLE orders(id, payment_env, payment_method, token, note);
                    CREATE TABLE payment_attempts(id, order_id, created, state, checked, reference);
                    INSERT INTO orders VALUES(1,'demo','line_pay','sensitive-token','private-note');
                    INSERT INTO payment_attempts VALUES(1,1,0,'paid',99999999,'secret-ref');
                """)
            doc = capture(path, 1500)
            self.assertEqual(doc, snapshot(1500, 1500, attempt("paid")))
            self.assertEqual(group([doc, capture(path, 3500)])["certain"], 1)


if __name__ == "__main__":
    unittest.main()
