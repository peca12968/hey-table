"""Measure threshold exposure under a bounded last-reading hold model."""
import argparse
from contextlib import closing
from dataclasses import asdict, dataclass, fields
import json
from pathlib import Path
import sqlite3


@dataclass
class Exposure:
    above_ms: int = 0
    at_or_below_ms: int = 0
    straddling_ms: int = 0
    unobserved_ms: int = 0
    covered_excess_min_mC_ms: int = 0
    covered_excess_max_mC_ms: int = 0

    def record(self, duration, low, high, threshold):
        if low is None:
            self.unobserved_ms += duration
            return
        if low > threshold:
            self.above_ms += duration
        elif high <= threshold:
            self.at_or_below_ms += duration
        else:
            self.straddling_ms += duration
        self.covered_excess_min_mC_ms += max(0, low - threshold) * duration
        self.covered_excess_max_mC_ms += max(0, high - threshold) * duration

    def add(self, other):
        for field in fields(self):
            setattr(self, field.name, getattr(self, field.name) + getattr(other, field.name))

    def report(self):
        return {**asdict(self), "possible_above_ms": [self.above_ms,
                self.above_ms + self.straddling_ms + self.unobserved_ms]}


READINGS = """
    SELECT time_ms, min(milli_c), max(milli_c) FROM readings
    WHERE device=? AND time_ms>=? AND time_ms<? GROUP BY time_ms ORDER BY time_ms
"""


def windows(db, device, start, stop, width, hold, threshold):
    if not 0 <= start < stop <= 2**63 - 1 or width < 1 or hold < 1:
        raise ValueError("Expected nonnegative start, a later signed-64-bit end, and positive window/hold")
    with closing(db.execute(READINGS, (device, max(0, start - hold + 1), stop))) as readings:
        upcoming = next(readings, None)
        current = None
        cursor = start
        total = Exposure()
        while cursor < stop:
            left = cursor
            right = min(stop, (left // width + 1) * width)
            bucket = Exposure()
            while cursor < right:
                while upcoming is not None and upcoming[0] <= cursor:
                    current, upcoming = upcoming, next(readings, None)
                boundary = min(right, upcoming[0]) if upcoming is not None else right
                low = high = None
                if current is not None and cursor < current[0] + hold:
                    boundary = min(boundary, current[0] + hold)
                    low, high = current[1:]
                bucket.record(boundary - cursor, low, high, threshold)
                cursor = boundary
            total.add(bucket)
            yield {"kind": "window", "device": device, "start_ms": left, "end_ms": right, **bucket.report()}
        yield {"kind": "total", "device": device, "start_ms": start, "end_ms": stop, **total.report()}


def run(path, devices, start, stop, width, hold, threshold):
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.execute("BEGIN")
        for device in dict.fromkeys(devices):
            yield from windows(db, device, start, stop, width, hold, threshold)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("devices", nargs="+")
    for name in ("start-ms", "end-ms", "window-ms", "hold-ms", "threshold-mc"):
        parser.add_argument("--" + name, type=int, required=True)
    args = parser.parse_args()
    try:
        for record in run(args.database, args.devices, args.start_ms, args.end_ms, args.window_ms,
                          args.hold_ms, args.threshold_mc):
            print(json.dumps(record))
    except (sqlite3.Error, ValueError, OSError) as error:
        parser.exit(2, f"{error}\n")
