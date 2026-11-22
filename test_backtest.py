from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

from backtest import Revision, backtest, day_number, read_history


ROOT = Path(__file__).resolve().parent
EXAMPLE = ROOT / "examples/sales.csv"
START = day_number("2026-06-01")


def example(path=EXAMPLE, truth="2026-06-22"):
    return subprocess.run([sys.executable, ROOT / "backtest.py", path, "--first", "2026-06-15",
                           "--last", "2026-06-18", "--truth-as-of", truth, "--details"], capture_output=True)


def latest(records, day, cutoff):
    candidates = [r for r in records if r.day == day and r.reported <= cutoff]
    return max(candidates, key=lambda r: r.reported).units if candidates else None


def independently_rebuild(records, origin, cutoff, lookback, horizon):
    # Re-query all revisions for each day. No rolling snapshot or seasonal sum shortcut.
    training = {day: latest(records, day, origin-1) for day in range(origin-lookback, origin)}
    observed = [latest(records, day, cutoff) for day in range(origin, origin+horizon)]
    predicted = None
    if None not in training.values():
        mean = Decimal(sum(training.values()) * horizon) / lookback
        seasonal = 0
        for day in range(origin, origin+horizon):
            while day >= origin:
                day -= 7
            seasonal += training[day]
        predicted = {"trailing_mean": int(mean.to_integral_value(rounding=ROUND_HALF_UP)), "last_week": seasonal}
    return {"predicted": predicted, "actual": None if None in observed else sum(observed),
            "missing_training": [date.fromordinal(d).isoformat() for d, v in training.items() if v is None],
            "missing_actual": [date.fromordinal(origin+i).isoformat() for i, v in enumerate(observed) if v is None]}


class BacktestTests(unittest.TestCase):
    def test_checkout_fixture_and_same_day_revision(self):
        p = example()
        self.assertEqual(p.returncode, 0, p.stderr)
        report = json.loads(p.stdout)
        self.assertEqual(report["coverage"], {"origins": 8, "forecastable": 6, "scored": 5,
                                              "missing_actual": 1, "actual_units": 60})
        self.assertEqual(report["models"]["last_week"],
                         {"absolute_error_units": 12, "signed_error_units": -12, "mae_units": 2.4, "wape": .2})
        self.assertEqual(report["models"]["trailing_mean"]["mae_units"], 4.8)
        row = report["rows"][0]
        self.assertEqual((row["origin"], row["sku"], row["predicted"]["last_week"], row["actual"]),
                         ("2026-06-15", "SPARK", 13, 23))
        history = read_history(EXAMPLE)
        later = day_number("2026-06-22")
        source = [r for r in history if r.sku == "SPARK"]
        self.assertEqual(latest(source, START+7, later) + latest(source, START+8, later), 21)

    def test_moving_truth_cutoff_changes_scoring_without_changing_predictions(self):
        before, after = [json.loads(example(truth=d).stdout) for d in ("2026-06-19", "2026-06-23")]
        self.assertEqual([r["predicted"] for r in before["rows"]], [r["predicted"] for r in after["rows"]])
        self.assertEqual((before["rows"][0]["actual"], after["rows"][0]["actual"]), (21, 23))
        self.assertEqual((before["coverage"]["scored"], after["coverage"]["scored"]), (5, 6))

    def test_independent_daily_snapshots(self):
        rng = random.Random(61280)
        for case in range(100):
            lookback, horizon = rng.randint(7, 17), rng.randint(1, 15)
            records = []
            for d in range(48):
                if rng.random() < .05:
                    continue
                day = START + d
                first = day + rng.choice((0, 0, 0, 1, 2))
                records.append(Revision("A", day, first, rng.randrange(30)))
                if rng.random() < .4:
                    records.append(Revision("A", day, first+rng.randint(1, 12), rng.randrange(30)))
            records.extend(records[:3])
            rng.shuffle(records)
            cutoff = START + 49
            report = backtest(records, START+18, START+27, cutoff, lookback, horizon, True)
            expected = [independently_rebuild(records, origin, cutoff, lookback, horizon)
                        for origin in range(START+18, START+28)]
            with self.subTest(case=case):
                self.assertEqual(len(report["rows"]), 10)
                for row, ref in zip(report["rows"], expected, strict=True):
                    self.assertEqual({k: row[k] for k in ref}, ref)
                scored = [r for r in expected if r["predicted"] is not None and r["actual"] is not None]
                self.assertEqual(report["coverage"]["scored"], len(scored))
                for model, result in report["models"].items():
                    errors = [r["predicted"][model]-r["actual"] for r in scored]
                    self.assertEqual(result["absolute_error_units"], sum(map(abs, errors)))
                    self.assertEqual(result["signed_error_units"], sum(errors))

    def test_zero_demand_and_new_sku(self):
        rows = [Revision("zero", START+i, START+i, 0) for i in range(9)]
        rows.append(Revision("new", START+8, START+8, 9))
        report = backtest(rows, START+7, START+8, START+8, 7, 1, True)
        self.assertEqual(report["coverage"]["origins"], 2)
        self.assertEqual(report["coverage"]["scored"], 2)
        self.assertEqual(report["models"]["last_week"]["mae_units"], 0)
        self.assertIsNone(report["models"]["last_week"]["wape"])
        empty = backtest([], START+7, START+8, START+8, 7, 1)
        self.assertIsNone(empty["models"]["last_week"]["mae_units"])

    def test_audit_explains_same_day_revision_and_late_zero(self):
        history = read_history(EXAMPLE)
        args = (history, START+14, START+14, START+21, 14, 2)
        ordinary = backtest(*args, details=True)
        audited = backtest(*args, audit=True)
        spark, tea = audited["rows"]
        self.assertEqual(spark.pop("later_training_changes"), [{"day": "2026-06-08", "as_known_units": 4,
                         "settled_units": 12, "settled_reported_on": "2026-06-15"}])
        self.assertEqual(tea.pop("later_training_changes"), [{"day": "2026-06-10", "as_known_units": None,
                         "settled_units": 0, "settled_reported_on": "2026-06-16"}])
        self.assertEqual(audited, ordinary)

    def test_invalid_inputs_do_not_print_a_partial_report(self):
        header = "day,reported_on,sku,units\n"
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "sales.csv"
            for body in ("2026-06-02,2026-06-01,A,1", "2026-06-01,2026-06-02,A,-1",
                         "2026-06-01,2026-06-01,,5", "2026-02-30,2026-06-01,A,1",
                         "2026-06-01,2026-06-02,A,2\n2026-06-01,2026-06-02,A,3"):
                p.write_text(header + body, encoding="utf-8")
                result = example(p)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(result.stdout)
        self.assertEqual(example(truth="2026-06-18").returncode, 2)


if __name__ == "__main__":
    unittest.main()
