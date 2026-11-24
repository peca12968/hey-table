"""Measure order-level time to recorded payment using successive Hey Table observations."""

import argparse
from collections import defaultdict
from contextlib import closing
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import sqlite3
import time

FORMAT = "wallet-observer.v1"
PAID = {"paid", "partial", "refunded"}
RETRYABLE = {"failed", "cancelled"}
STATES = {"pending", "authorized"} | PAID | RETRYABLE
REACHABLE = {
    "pending": STATES,
    "authorized": {"authorized", "paid", "cancelled", "partial", "refunded"},
    "paid": PAID,
    "partial": {"partial", "refunded"},
    "refunded": {"refunded"},
    "failed": {"failed"},
    "cancelled": {"cancelled"},
}
METHODS = {
    "line_pay",
    "px_pay_plus",
    "easy_wallet",
    "jko_pay",
    "plus_pay",
    "pi_wallet",
    "card",
}
ENVS = {"demo", "sandbox", "production"}


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ValueError("invalid timestamp, identifier or duration")
    return value


@dataclass(frozen=True)
class Attempt:
    id: int
    order: int
    created: int
    environment: str
    method: str
    state: str

    def identity(self):
        return (self.order, self.created, self.environment, self.method)


def capture(path, as_of=None):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("BEGIN")
        start = time.time_ns() // 1_000_000
        # Pin the SQLite snapshot before scanning potentially many attempts.
        db.execute("SELECT rootpage FROM sqlite_schema WHERE name='orders'").fetchone()
        end = time.time_ns() // 1_000_000
        rows = db.execute("""SELECT a.id, a.order_id, a.created, o.payment_env, o.payment_method, a.state
                             FROM payment_attempts a LEFT JOIN orders o ON o.id=a.order_id ORDER BY a.id""")
        result = {
            "format": FORMAT,
            "earliest_ms": start if as_of is None else as_of,
            "latest_ms": end if as_of is None else as_of,
            "attempts": [asdict(Attempt(*row)) for row in rows],
        }
    parse(result)
    return result


def parse(doc):
    if (
        not isinstance(doc, dict)
        or doc.get("format") != FORMAT
        or not isinstance(doc.get("attempts"), list)
    ):
        raise ValueError("expected a complete wallet-observer.v1 snapshot")
    lo, hi = integer(doc.get("earliest_ms")), integer(doc.get("latest_ms"))
    if lo > hi:
        raise ValueError("reversed observation interval")
    rows = {}
    for raw in doc["attempts"]:
        if (
            not isinstance(raw, dict)
            or raw.keys() != Attempt.__dataclass_fields__.keys()
        ):
            raise ValueError("unexpected attempt fields")
        attempt = Attempt(**raw)
        integer(attempt.id, 1)
        integer(attempt.order, 1)
        integer(attempt.created)
        if not all(
            isinstance(v, str)
            for v in (attempt.state, attempt.method, attempt.environment)
        ):
            raise ValueError("invalid payment attributes")
        if (
            attempt.state not in STATES
            or attempt.environment not in ENVS
            or attempt.method not in METHODS
        ):
            raise ValueError("unrecognized payment attributes")
        if attempt.id in rows or attempt.created > hi:
            raise ValueError("duplicate attempt or creation after observation")
        rows[attempt.id] = attempt
    for attempts in by_order(rows).values():
        for a, b in zip(attempts, attempts[1:]):
            if (
                a.state not in RETRYABLE
                or a.created > b.created
                or (a.method, a.environment) != (b.method, b.environment)
            ):
                raise ValueError("inconsistent retry chain for order")
    return lo, hi, rows


def by_order(rows):
    orders = defaultdict(list)
    for attempt in sorted(rows.values(), key=lambda a: a.id):
        orders[attempt.order].append(attempt)
    return orders


def analyze(snapshots, seconds, environment, from_ms=None, until_ms=None):
    duration = 1000 * integer(seconds, 1)
    for boundary in (from_ms, until_ms):
        if boundary is not None:
            integer(boundary)
    if from_ms is not None and until_ms is not None and from_ms >= until_ms:
        raise ValueError("empty first-attempt cohort interval")
    if environment not in ENVS:
        raise ValueError("unknown payment environment")
    prior = {}
    previous_lo = previous_hi = observed_from = None
    first_paid_by = {}
    last_unpaid_from = {}
    for doc in snapshots:
        lo, hi, rows = parse(doc)
        if (lo, hi) == (previous_lo, previous_hi) and rows == prior:
            continue
        if previous_hi is not None and lo < previous_hi:
            raise ValueError("observations overlap or are out of order")
        # All rows were visible in the same database snapshot, including rows
        # belonging to another wallet. It cannot predate their creation.
        previous_from = observed_from
        observed_from = max(lo, max((a.created for a in rows.values()), default=lo))
        if prior.keys() - rows.keys():
            raise ValueError("attempt disappeared between complete snapshots")
        for key, attempt in rows.items():
            old = prior.get(key)
            if old:
                if (
                    attempt.identity() != old.identity()
                    or attempt.state not in REACHABLE[old.state]
                ):
                    raise ValueError("attempt identity changed or state went backwards")
            elif previous_from is not None:
                # The application can assign created before the insert commits.
                # Absence from a complete snapshot is evidence of no recorded payment.
                last_unpaid_from[key] = previous_from
            if attempt.state in PAID:
                first_paid_by.setdefault(key, hi)
            else:
                last_unpaid_from[key] = observed_from
        prior, previous_lo, previous_hi = rows, lo, hi
    if previous_lo is None:
        raise ValueError("at least one snapshot is required")
    groups = {}
    for attempts in by_order(prior).values():
        first, last = attempts[0], attempts[-1]
        if first.environment != environment:
            continue
        if from_ms is not None and first.created < from_ms:
            continue
        if until_ms is not None and first.created >= until_ms:
            continue
        group = groups.setdefault(
            first.method,
            {
                "orders": 0,
                "attempts": 0,
                "immature": 0,
                "certain": 0,
                "missed": 0,
                "uncertain": 0,
            },
        )
        group["orders"] += 1
        group["attempts"] += len(attempts)
        deadline = first.created + duration
        if observed_from <= deadline:
            group["immature"] += 1
        elif last.state not in PAID or last.created > deadline:
            group["missed"] += 1
        elif first_paid_by[last.id] <= deadline:
            group["certain"] += 1
        elif last_unpaid_from.get(last.id, -1) > deadline:
            group["missed"] += 1
        else:
            group["uncertain"] += 1
    for group in groups.values():
        group["eligible"] = group["orders"] - group["immature"]
        group["on_time_count_range"] = [
            group["certain"],
            group["certain"] + group["uncertain"],
        ]
    return {
        "environment": environment,
        "deadline_seconds": seconds,
        "first_attempt_interval_ms": [from_ms, until_ms],
        "by_method": dict(sorted(groups.items())),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sample = sub.add_parser(
        "capture", help="project a local Hey Table SQLite database to JSON"
    )
    sample.add_argument("database", type=Path)
    sample.add_argument(
        "--as-of-ms", type=int, help="known snapshot time for an existing backup"
    )
    report = sub.add_parser("report")
    report.add_argument("files", nargs="+", type=Path)
    report.add_argument("--seconds", type=int, default=300)
    report.add_argument("--environment", choices=sorted(ENVS), required=True)
    report.add_argument("--from-ms", type=int, help="inclusive first-attempt timestamp")
    report.add_argument(
        "--until-ms", type=int, help="exclusive first-attempt timestamp"
    )
    args = parser.parse_args()
    try:
        if args.command == "capture":
            result = capture(args.database, args.as_of_ms)
        else:
            result = analyze(
                (json.loads(file.read_bytes()) for file in args.files),
                args.seconds,
                args.environment,
                args.from_ms,
                args.until_ms,
            )
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.exit(2, f"{parser.prog}: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
