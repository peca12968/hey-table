"""Create an online SQLite snapshot or restore one against a recorded digest."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from tempfile import TemporaryDirectory


def readonly(path, *, immutable=False):
    options = "mode=ro&immutable=1" if immutable else "mode=ro"
    return sqlite3.connect(f"{path.resolve().as_uri()}?{options}", uri=True)


def check_database(path):
    # A zero-byte file is also accepted as an empty database by SQLite.
    with path.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\x00":
            raise ValueError("Missing SQLite database header")
    with closing(readonly(path, immutable=True)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        result = db.execute("PRAGMA integrity_check").fetchone()
        if result != ("ok",):
            raise ValueError(f"SQLite integrity check failed: {result}")
        violation = db.execute("PRAGMA foreign_key_check").fetchone()
        if violation:
            raise ValueError(f"Foreign key violation in table {violation[0]}")


def publish(staged, destination):
    suffixes = ("-wal", "-shm", "-journal")
    if destination.name.lower().endswith(suffixes):
        raise ValueError("Destination name is reserved for SQLite sidecar files")
    if any(os.path.lexists(str(destination) + suffix) for suffix in suffixes):
        raise ValueError("SQLite sidecar already exists at the destination")
    # Both paths are on the same filesystem. Concurrent publishers cannot overwrite a winner.
    os.link(staged, destination)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def snapshot(source, destination):
    with TemporaryDirectory(dir=destination.parent) as temp:
        staged = Path(temp) / "snapshot.db"
        staged.touch(mode=0o600)
        with closing(readonly(source)) as live, closing(sqlite3.connect(staged)) as copy:
            # Pin the committed view for the entire incremental backup.
            live.execute("BEGIN")
            if live.execute("PRAGMA page_count").fetchone()[0] == 0:
                raise ValueError("Source has no database pages")
            live.backup(copy, pages=128)
            live.rollback()
            copy.execute("PRAGMA journal_mode=DELETE")
        check_database(staged)
        sha = digest(staged)
        size = staged.stat().st_size
        publish(staged, destination)
    return {"snapshot": str(destination), "sha256": sha, "bytes": size}


def restore(source, destination, expected):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected):
        raise ValueError("Expected a 64-character SHA-256 digest")
    with TemporaryDirectory(dir=destination.parent) as temp:
        staged = Path(temp) / "restored.db"
        staged.touch(mode=0o600)
        with source.open("rb") as backup, staged.open("wb") as target:
            shutil.copyfileobj(backup, target, length=1024 * 1024)
        sha = digest(staged)
        if sha != expected.lower():
            raise ValueError("Snapshot SHA-256 mismatch")
        check_database(staged)
        publish(staged, destination)
    return {"restored": str(destination), "sha256": sha}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("snapshot", "restore"):
        command = commands.add_parser(name)
        command.add_argument("source", type=Path)
        command.add_argument("destination", type=Path)
        if name == "restore":
            command.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        if args.command == "snapshot":
            result = snapshot(args.source, args.destination)
        else:
            result = restore(args.source, args.destination, args.sha256)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
