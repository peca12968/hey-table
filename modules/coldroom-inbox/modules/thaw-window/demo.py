"""Create a temporary freezer monitoring dataset and verify its exposure report."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory

from thaw import run


SCHEMA = """CREATE TABLE readings (device TEXT NOT NULL, id TEXT NOT NULL, time_ms INTEGER NOT NULL,
            milli_c INTEGER NOT NULL, PRIMARY KEY(device,id)) WITHOUT ROWID"""
SAMPLES = [(12000, -13000), (3000, -14000), (0, -18000), (9000, -15000), (9000, -17000)]


def exercise():
    with TemporaryDirectory() as temp:
        source = Path(temp) / "freezer.db"
        with closing(sqlite3.connect(source)) as db:
            db.execute(SCHEMA)
            db.executemany("INSERT INTO readings VALUES ('north',?,?,?)",
                           [(str(i), at, temperature) for i, (at, temperature) in enumerate(SAMPLES)])
            db.commit()
        *windows, total = run(source, ["north"], 1000, 16000, 5000, 4000, -16000)
        assert [w["possible_above_ms"] for w in windows] == [[2000, 2000], [2000, 5000], [3000, 5000], [1000, 1000]]
        assert total["possible_above_ms"] == [8000, 13000]
        assert [total[k] for k in ("at_or_below_ms", "unobserved_ms", "straddling_ms")] == [2000, 2000, 3000]
        assert [total[k] for k in ("covered_excess_min_mC_ms", "covered_excess_max_mC_ms")] == [20000000, 23000000]
        return total


if __name__ == "__main__":
    print(json.dumps(exercise(), indent=2))
