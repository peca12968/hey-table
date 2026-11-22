"""Replay replenishment forecasts using only sales reports available at each origin."""
import argparse
from collections import Counter, defaultdict
import csv
from dataclasses import dataclass
from datetime import date
import json
from pathlib import Path
import re


MODELS = ("trailing_mean", "last_week")


def day_number(text):
    if not isinstance(text, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text):
        raise ValueError(f"expected YYYY-MM-DD, got {text!r}")
    return date.fromisoformat(text).toordinal()


def iso(day):
    return date.fromordinal(day).isoformat()


@dataclass(frozen=True)
class Revision:
    sku: str
    day: int
    reported: int
    units: int


def read_history(path):
    history = []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, strict=True)
        if sorted(reader.fieldnames or []) != ["day", "reported_on", "sku", "units"]:
            raise ValueError("expected sku,day,reported_on,units columns")
        for row in reader:
            try:
                if None in row or None in row.values() or not row["sku"].strip():
                    raise ValueError("incomplete record or extra column")
                if not re.fullmatch(r"[0-9]+", row["units"]):
                    raise ValueError("units must be a nonnegative integer")
                day, reported = day_number(row["day"]), day_number(row["reported_on"])
                if reported < day:
                    raise ValueError("sales cannot be reported before their business day")
                history.append(Revision(row["sku"], day, reported, int(row["units"])))
            except ValueError as exc:
                raise ValueError(f"line {reader.line_num}: {exc}") from exc
    return history


def forecast(history, horizon):
    # Round one lead-time total half up. Daily rounding would accumulate error.
    trailing = (2 * sum(history) * horizon + len(history)) // (2 * len(history))
    weeks, extra = divmod(horizon, 7)
    week = history[-7:]
    return {"trailing_mean": trailing, "last_week": weeks * sum(week) + sum(week[:extra])}


def backtest(history, first, last, truth_as_of, lookback, horizon, details=False, audit=False):
    if lookback < 7 or horizon < 1 or last < first or first-lookback < 1:
        raise ValueError("require ordered origins, at least 7 training days and a positive horizon")
    if last + horizon - 1 > truth_as_of:
        raise ValueError("truth cutoff must include the last forecast day")
    by_sku = defaultdict(dict)
    for r in history:
        if r.reported > truth_as_of:
            continue
        revisions = by_sku[r.sku]
        key = (r.reported, r.day)
        if key in revisions and revisions[key] != r.units:
            raise ValueError(f"conflicting revisions: {r.sku} {iso(r.day)} on {iso(r.reported)}")
        revisions[key] = r.units

    coverage = Counter()
    errors = {model: Counter() for model in MODELS}
    rows = []
    for sku, revisions in sorted(by_sku.items()):
        versions = sorted(revisions.items())
        truth = {day: (reported, units) for (reported, day), units in versions}
        known = {}
        cursor = 0
        for origin in range(first, last+1):
            # Reports stamped on the origin day arrive after the forecast is issued.
            while cursor < len(versions) and versions[cursor][0][0] < origin:
                (_, day), units = versions[cursor]
                known[day] = units
                cursor += 1
            if not known:
                continue
            training = range(origin-lookback, origin)
            target = range(origin, origin+horizon)
            missing_training = [day for day in training if day not in known]
            missing_actual = [day for day in target if day not in truth]
            predicted = None if missing_training else forecast([known[day] for day in training], horizon)
            actual = None if missing_actual else sum(truth[day][1] for day in target)
            coverage["origins"] += 1
            if not missing_training:
                coverage["forecastable"] += 1
            if missing_actual:
                coverage["missing_actual"] += 1
            if predicted is not None and actual is not None:
                coverage["scored"] += 1
                coverage["actual_units"] += actual
                for model, total in predicted.items():
                    delta = total - actual
                    errors[model]["signed"] += delta
                    errors[model]["absolute"] += abs(delta)
            if details or audit:
                row = {"sku": sku, "origin": iso(origin), "predicted": predicted, "actual": actual,
                       "missing_training": list(map(iso, missing_training)), "missing_actual": list(map(iso, missing_actual))}
                if audit:
                    row["later_training_changes"] = [
                        {"day": iso(day), "as_known_units": known.get(day), "settled_units": truth[day][1],
                         "settled_reported_on": iso(truth[day][0])}
                        for day in training if day in truth and truth[day][1] != known.get(day)]
                rows.append(row)

    scores = {}
    for model, totals in errors.items():
        n, actual = coverage["scored"], coverage["actual_units"]
        scores[model] = {"absolute_error_units": totals["absolute"], "signed_error_units": totals["signed"],
                         "mae_units": totals["absolute"] / n if n else None,
                         "wape": totals["absolute"] / actual if actual else None}
    result = {"first_origin": iso(first), "last_origin": iso(last), "truth_as_of": iso(truth_as_of),
              "lookback_days": lookback, "horizon_days": horizon,
              "coverage": {k: coverage[k] for k in ("origins", "forecastable", "missing_actual", "scored", "actual_units")},
              "models": scores}
    if details or audit:
        result["rows"] = rows
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history", type=Path)
    parser.add_argument("--first", required=True, metavar="DAY")
    parser.add_argument("--last", required=True, metavar="DAY")
    parser.add_argument("--truth-as-of", required=True, metavar="DAY")
    parser.add_argument("--lookback", type=int, default=14)
    parser.add_argument("--horizon", type=int, default=2)
    parser.add_argument("--details", action="store_true")
    parser.add_argument("--audit", action="store_true", help="show the rows and training values revised by the settlement date")
    args = parser.parse_args()
    try:
        result = backtest(read_history(args.history), day_number(args.first), day_number(args.last),
                          day_number(args.truth_as_of), args.lookback, args.horizon, args.details, args.audit)
    except (ValueError, OSError, csv.Error, OverflowError) as error:
        parser.exit(2, f"{parser.prog}: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
