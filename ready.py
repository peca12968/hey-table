"""Bound order-to-ready times from serial hey-table kitchen exports."""

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import sys


STATES = {
    "pending": {"pending", "preparing", "ready", "completed", "cancelled"},
    "preparing": {"preparing", "ready", "completed"},
    "ready": {"ready", "completed"},
    "completed": {"completed"},
    "cancelled": {"cancelled"},
}
TERMINAL = {"completed", "cancelled"}


def integer(value, field, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise ValueError(f"invalid {field}")
    return value


def project(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("format") != "hey-table.station-orders.v1":
        raise ValueError("expected a hey-table station export")
    captured = integer(snapshot.get("capturedAt"), "capturedAt")
    through = integer(snapshot.get("throughId"), "throughId")
    if not isinstance(snapshot.get("orders"), list):
        raise ValueError("expected an orders array")
    rows = {}
    for row in snapshot["orders"]:
        if not isinstance(row, dict):
            raise ValueError("invalid order")
        key = integer(row.get("id"), "order ID", 1)
        created = integer(row.get("created"), "creation time")
        mode, state = row.get("mode"), row.get("status")
        if mode not in ("table", "pickup") or not isinstance(state, str) or state not in STATES:
            raise ValueError(f"invalid mode or status on order {key}")
        if created > captured or key in rows:
            raise ValueError(f"invalid timestamp or duplicate order {key}")
        rows[key] = (created, mode, state)
    if max(rows, default=0) != through:
        raise ValueError("throughId disagrees with orders")
    if sum(state in TERMINAL for _, _, state in rows.values()) > 20:
        raise ValueError("too many terminal orders for a station export")
    return captured, through, rows


@dataclass
class Order:
    created: int
    mode: str
    state: str
    earliest: int | None = 0
    latest: int | None = None

    def observe(self, state, previous_capture, capture):
        if state not in STATES[self.state]:
            raise ValueError(f"invalid change from {self.state} to {state}")
        self.state = state
        if state == "cancelled":
            self.earliest = self.latest = None
        elif state in ("ready", "completed"):
            if self.latest is None:
                self.latest = capture - self.created
        elif previous_capture is not None:
            self.earliest = max(self.earliest, previous_capture - self.created)

    def evict(self, capture):
        if self.state == "preparing":
            # Cancellation is impossible after preparing. A terminal order was ready.
            self.state = "inferred_completed"
            self.latest = capture - self.created
        elif self.state == "pending":
            self.state = "terminal_unknown"
        elif self.state == "ready":
            self.state = "inferred_completed"

    def result(self, key, threshold):
        if self.latest is not None and self.latest <= threshold:
            outcome = "on_time"
        elif self.earliest is None or self.earliest > threshold:
            outcome = "missed"
        else:
            outcome = "uncertain"
        return dict(id=key, mode=self.mode, evidence=self.state, earliestMs=self.earliest,
                    latestMs=self.latest, outcome=outcome)


def percentile(rows, field, percent):
    # None denotes positive infinity. Its sorted rank follows all finite values.
    finite = sorted(row[field] for row in rows if row[field] is not None)
    rank = (len(rows) * percent + 99) // 100
    return finite[rank - 1] if 0 < rank <= len(finite) else None


def report(snapshots, target_seconds, mode=None):
    threshold = integer(target_seconds, "target seconds") * 1000
    if mode not in (None, "table", "pickup"):
        raise ValueError("unknown service mode")
    orders = {}
    previous = None
    through = 0
    last_rows = {}
    for snapshot in snapshots:
        capture, high, rows = project(snapshot)
        if previous == capture and rows == last_rows:
            continue
        if previous is not None and (capture <= previous or high < through):
            raise ValueError("expected chronological, serial exports from one store")
        for key, (created, service, state) in rows.items():
            if key not in orders:
                orders[key] = Order(created, service, "pending")
            elif key not in last_rows or (orders[key].created, orders[key].mode) != (created, service):
                raise ValueError(f"reappearing order or changed identity: {key}")
            orders[key].observe(state, previous, capture)
        terminal_ids = [key for key, (_, _, state) in rows.items() if state in TERMINAL]
        for key in last_rows.keys() - rows.keys():
            if len(terminal_ids) != 20 or key >= min(terminal_ids):
                raise ValueError(f"missing order {key} cannot be explained by the terminal window")
            orders[key].evict(capture)
        previous, through, last_rows = capture, high, rows
    if previous is None:
        raise ValueError("provide at least one snapshot")
    results = [order.result(key, threshold) for key, order in sorted(orders.items())
               if mode is None or order.mode == mode]
    counts = {kind: sum(row["outcome"] == kind for row in results)
              for kind in ("on_time", "uncertain", "missed")}
    return dict(targetSeconds=target_seconds, observed=len(results), counts=counts,
                onTimeCountRange=[counts["on_time"], counts["on_time"] + counts["uncertain"]],
                percentileMs={f"p{p}": [percentile(results, field, p)
                                         for field in ("earliestMs", "latestMs")] for p in (50, 90)},
                orders=results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, nargs="+", help="station exports, oldest first")
    parser.add_argument("--target-seconds", type=int, required=True)
    parser.add_argument("--mode", choices=("table", "pickup"))
    args = parser.parse_args()
    try:
        snapshots = (json.loads(path.read_text(encoding="utf-8-sig")) for path in args.snapshot)
        data = report(snapshots, args.target_seconds, args.mode)
    except (OSError, ValueError) as exc:
        parser.exit(2, f"ready-range: {exc}\n")
    json.dump(data, sys.stdout, ensure_ascii=True, indent=2)
    print()


if __name__ == "__main__":
    main()
