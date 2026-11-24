from contextlib import closing
import json
from pathlib import Path
from random import Random
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from demo import exercise, SCHEMA
from thaw import run, windows


class ExposureTests(unittest.TestCase):
    def test_published_scenario(self):
        self.assertEqual(exercise()["above_ms"], 8000)

    def test_boundary_sweep_against_per_millisecond_oracle(self):
        rng = Random(731)
        with closing(sqlite3.connect(":memory:")) as db:
            db.execute(SCHEMA)
            for _ in range(240):
                db.execute("DELETE FROM readings")
                points = [(rng.randrange(45), rng.randrange(-3, 4)) for _ in range(rng.randrange(25))]
                db.executemany("INSERT INTO readings VALUES ('d',?,?,?)",
                               [(str(i), t, v) for i, (t, v) in enumerate(points)])
                start, stop = rng.randrange(18), rng.randrange(22, 60)
                width, hold, threshold = rng.randrange(1, 18), rng.randrange(1, 20), rng.randrange(-2, 3)
                rows = list(windows(db, "d", start, stop, width, hold, threshold))
                self.assertEqual(rows[0]["start_ms"], start)
                self.assertEqual(rows[-2]["end_ms"], stop)
                for i, record in enumerate(rows):
                    left, right = record["start_ms"], record["end_ms"]
                    if record["kind"] == "window" and i:
                        self.assertEqual(left % width, 0)
                        self.assertEqual(left, rows[i - 1]["end_ms"])
                    above = below = mixed = missing = excess_lo = excess_hi = 0
                    for now in range(left, right):
                        fresh = [(t, v) for t, v in points if now - hold < t <= now]
                        if not fresh:
                            missing += 1
                            continue
                        latest = max(t for t, _ in fresh)
                        possible = [v for t, v in fresh if t == latest]
                        above += all(v > threshold for v in possible)
                        below += all(v <= threshold for v in possible)
                        mixed += min(possible) <= threshold < max(possible)
                        excess_lo += max(0, min(possible) - threshold)
                        excess_hi += max(0, max(possible) - threshold)
                    self.assertEqual([record[k] for k in ("above_ms", "at_or_below_ms", "straddling_ms",
                                     "unobserved_ms", "covered_excess_min_mC_ms", "covered_excess_max_mC_ms")],
                                     [above, below, mixed, missing, excess_lo, excess_hi])
                    self.assertEqual(record["possible_above_ms"], [above, right - left - below])

    def test_all_devices_share_one_read_transaction(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "readings with space #.db"
            with closing(sqlite3.connect(path)) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute(SCHEMA)
                db.execute("INSERT INTO readings VALUES ('first','a',0,3)")
                db.commit()
                report = run(path, ["first", "second"], 0, 4, 4, 1, 2)
                self.assertEqual(next(report)["above_ms"], 1)
                db.execute("INSERT INTO readings VALUES ('second','b',0,3)")
                db.commit()
                self.assertEqual(list(report)[-1]["above_ms"], 0)
                self.assertEqual(list(run(path, ["second"], 0, 4, 4, 4, 2))[-1]["above_ms"], 4)

    def test_cli_empty_input_range_and_read_only_open(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "source.db"
            command = [sys.executable, Path(__file__).with_name("thaw.py"), path, "silent", "--start-ms", "5",
                       "--end-ms", "13", "--window-ms", "8", "--hold-ms", "4", "--threshold-mc", "-1"]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 2)
            self.assertFalse(path.exists())
            with closing(sqlite3.connect(path)) as db:
                db.execute(SCHEMA)
            records = [json.loads(line) for line in subprocess.check_output(command).splitlines()]
            self.assertEqual([r["unobserved_ms"] for r in records], [3, 5, 8])
            invalid = subprocess.run([*command, "--hold-ms", "0"], capture_output=True)
            self.assertEqual((invalid.returncode, invalid.stdout), (2, b""))
