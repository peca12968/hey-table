"""Create an online SQLite snapshot or restore one against a recorded digest."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from tempfile import TemporaryDirectory


class InvalidSnapshot(ValueError):
    """The supplied bytes fail the recorded digest or database checks."""


class MissingSnapshot(FileNotFoundError):
    """The candidate file itself is missing."""


def readonly(path, *, immutable=False):
    options = "mode=ro&immutable=1" if immutable else "mode=ro"
    return sqlite3.connect(f"{path.resolve().as_uri()}?{options}", uri=True)


def check_database(path):
    # A zero-byte file is also accepted as an empty database by SQLite.
    with path.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\x00":
            raise InvalidSnapshot("Missing SQLite database header")
    with closing(readonly(path, immutable=True)) as db:
        db.execute("PRAGMA trusted_schema=OFF")
        result = db.execute("PRAGMA integrity_check").fetchone()
        if result != ("ok",):
            raise InvalidSnapshot(f"SQLite integrity check failed: {result}")
        violation = db.execute("PRAGMA foreign_key_check").fetchone()
        if violation:
            raise InvalidSnapshot(f"Foreign key violation in table {violation[0]}")


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
            captured_at = datetime.now(timezone.utc).isoformat()
            live.backup(copy, pages=128)
            live.rollback()
            copy.execute("PRAGMA journal_mode=DELETE")
        check_database(staged)
        sha = digest(staged)
        size = staged.stat().st_size
        publish(staged, destination)
    return {"snapshot": str(destination), "sha256": sha, "bytes": size, "captured_at": captured_at}


def restore(source, destination, expected):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected):
        raise ValueError("Expected a 64-character SHA-256 digest")
    with TemporaryDirectory(dir=destination.parent) as temp:
        staged = Path(temp) / "restored.db"
        staged.touch(mode=0o600)
        try:
            stream = source.open("rb")
        except FileNotFoundError as exc:
            raise MissingSnapshot(str(source)) from exc
        with stream as backup, staged.open("wb") as target:
            shutil.copyfileobj(backup, target, length=1024 * 1024)
        sha = digest(staged)
        if sha != expected.lower():
            raise InvalidSnapshot("Snapshot SHA-256 mismatch")
        try:
            check_database(staged)
        except sqlite3.DatabaseError as exc:
            primary_code = getattr(exc, "sqlite_errorcode", 0) & 255
            if primary_code in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB):
                raise InvalidSnapshot(str(exc)) from exc
            raise
        publish(staged, destination)
    return {"restored": str(destination), "sha256": sha}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Expected an ISO timestamp with a UTC offset")
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() is None:
        raise ValueError("Expected an ISO timestamp with a UTC offset")
    try:
        return parsed.astimezone(timezone.utc)
    except OverflowError as exc:
        raise ValueError("Timestamp is outside the UTC date range") from exc


def restore_latest(candidates, destination, not_before=None):
    floor = timestamp(not_before) if not_before is not None else None
    versions = {}
    for source, receipt in candidates:
        try:
            record = json.loads(receipt.read_text(encoding="utf-8-sig"))
            if not isinstance(record, dict):
                raise ValueError("Expected a JSON object")
            captured = timestamp(record.get("captured_at"))
            sha = record.get("sha256")
            if not isinstance(sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", sha):
                raise ValueError("Invalid SHA-256")
            if captured in versions:
                raise ValueError("Ambiguous recovery point: duplicate capture time")
        except ValueError as exc:
            raise ValueError(f"{receipt}: {exc}") from exc
        versions[captured] = (source, sha)

    skipped = []
    for captured in sorted(versions, reverse=True):
        source, sha = versions[captured]
        point = {"snapshot": str(source), "captured_at": captured.isoformat()}
        if floor is not None and captured < floor:
            skipped.append({**point, "reason": "before recovery cutoff"})
            continue
        try:
            result = restore(source, destination, sha)
        except MissingSnapshot:
            skipped.append({**point, "reason": "snapshot missing"})
        except InvalidSnapshot as exc:
            skipped.append({**point, "reason": str(exc)})
        else:
            return {**result, **point, "skipped": skipped}
    raise ValueError("No usable recovery point: " + json.dumps(skipped))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("snapshot", "restore"):
        command = commands.add_parser(name)
        command.add_argument("source", type=Path)
        command.add_argument("destination", type=Path)
        if name == "restore":
            command.add_argument("--sha256", required=True)
    latest = commands.add_parser("restore-latest", help="Restore the newest verified candidate")
    latest.add_argument("destination", type=Path)
    latest.add_argument("--candidate", type=Path, nargs=2, metavar=("SNAPSHOT", "RECEIPT"),
                        action="append", required=True)
    latest.add_argument("--not-before", help="Earliest acceptable capture timestamp, inclusive")
    args = parser.parse_args()
    try:
        if args.command == "snapshot":
            result = snapshot(args.source, args.destination)
        elif args.command == "restore":
            result = restore(args.source, args.destination, args.sha256)
        else:
            result = restore_latest(args.candidate, args.destination, args.not_before)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
