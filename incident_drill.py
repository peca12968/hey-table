"""Compare a time-bounded snapshot restore with an independently observed WAL commit."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory


def recovery(*args):
    return json.loads(subprocess.check_output([sys.executable, Path(__file__).with_name("recovery.py"), *args]))


def exercise(lantern):
    with TemporaryDirectory() as temp:
        root = Path(temp)
        source = root / "shop.db"
        args = []
        history = []
        with closing(sqlite3.connect(source)) as writer:
            writer.execute("pragma journal_mode=wal")
            writer.execute("pragma wal_autocheckpoint=0")
            writer.execute("create table stock(sku text primary key, available integer not null)")
            writer.execute("pragma wal_checkpoint(truncate)")
            changes = ["insert into stock values('BX-19', 8)", "update stock set available=11",
                       "update stock set available=0"]
            for index, change in enumerate(changes, 1):
                writer.execute(change)
                writer.commit()
                # The sole writer is idle throughout both observations.
                copy = root / f"version-{index}.db"
                receipt = root / f"version-{index}.json"
                evidence = recovery("snapshot", source, copy)
                receipt.write_text(json.dumps(evidence), encoding="utf-8")
                args.extend(["--candidate", copy, receipt])
                raw = root / f"version-{index}.wal"
                raw.write_bytes((root / "shop.db-wal").read_bytes())
                report = json.loads(subprocess.check_output([lantern, raw]))
                assert (report["commits"], report["stop"]) == (index, "end")
                history.append((evidence["captured_at"], report["last_commit_end_offset"]))
        assert history[0][1] < history[1][1] < history[2][1]
        restored = root / "before.db"
        chosen = recovery("restore-latest", restored, *args, "--not-after", history[1][0])
        latest = root / "latest.db"
        recovery("restore-latest", latest, *args)
        assert chosen["captured_at"] == history[1][0]
        assert [entry["reason"] for entry in chosen["skipped"]] == ["after recovery cutoff"]
        def available(path):
            with closing(sqlite3.connect(path)) as db:
                return db.execute("select available from stock where sku='BX-19'").fetchone()[0]
        assert (available(restored), available(latest)) == (11, 0)
        return {"observed_commit_end_offsets": [end for _, end in history], "bounded_stock": 11, "latest_stock": 0,
                "skipped": chosen["skipped"][0]["reason"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wal_lantern", type=Path)
    print(json.dumps(exercise(parser.parse_args().wal_lantern.resolve()), indent=2))
