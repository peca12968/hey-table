"""Content-defined incremental backups of individual files."""
import argparse
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile


MIN_CHUNK = 2048
MAX_CHUNK = 16384
GEAR = tuple(int.from_bytes(sha256(bytes([i])).digest()[:8], "big") for i in range(256))
MASK64 = (1 << 64) - 1
APP_ID = 0x53564631  # SVF1


def chunks(source, read_size=65536):
    """Yield nonempty Gear chunks, independent of the input read boundaries."""
    if read_size < 1:
        raise ValueError("read size must be positive")
    pending = bytearray()
    fingerprint = 0
    while data := source.read(read_size):
        for value in data:
            pending.append(value)
            fingerprint = ((fingerprint << 1) + GEAR[value]) & MASK64
            if len(pending) >= MIN_CHUNK and (fingerprint & 4095 == 0 or len(pending) == MAX_CHUNK):
                yield bytes(pending)
                pending.clear()
                fingerprint = 0
    if pending:
        yield bytes(pending)


def external_file(repo, path):
    root = repo.resolve()
    if path.parent.resolve().is_relative_to(root) or path.resolve().is_relative_to(root):
        raise ValueError("choose a file outside the backup repository")
    db = repo / "vault.sqlite3"
    if db.exists() and path.exists() and path.samefile(db):
        raise ValueError("the file aliases the backup database")


def schema(db, initialize=False):
    app_id = db.execute("PRAGMA application_id").fetchone()[0]
    if app_id == APP_ID and db.execute("PRAGMA user_version").fetchone()[0] == 1:
        return
    if not initialize or app_id or db.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone():
        raise ValueError("unrecognized backup database or format")
    db.execute("CREATE TABLE objects (hash BLOB PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID")
    db.execute("CREATE TABLE snapshots (id TEXT PRIMARY KEY, size INTEGER NOT NULL) WITHOUT ROWID")
    db.execute("""CREATE TABLE parts (snapshot TEXT REFERENCES snapshots(id), pos INTEGER,
               object BLOB NOT NULL REFERENCES objects(hash), PRIMARY KEY(snapshot, pos)) WITHOUT ROWID""")
    db.execute(f"PRAGMA application_id = {APP_ID}")
    db.execute("PRAGMA user_version = 1")


def backup(repo, source):
    external_file(repo, source)
    if not source.is_file():
        raise ValueError("backup source must be a regular file")
    repo.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as stream, closing(sqlite3.connect(repo / "vault.sqlite3", timeout=30)) as db, db:
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("BEGIN IMMEDIATE")
        schema(db, initialize=True)
        db.execute("CREATE TEMP TABLE ordered (pos INTEGER PRIMARY KEY, object BLOB NOT NULL)")
        digest = sha256()
        size = added = count = 0
        before = os.fstat(stream.fileno())
        for data in chunks(stream):
            key = sha256(data).digest()
            existing = db.execute("SELECT data FROM objects WHERE hash=?", (key,)).fetchone()
            if existing is None:
                db.execute("INSERT INTO objects VALUES (?,?)", (key, data))
                added += len(data)
            elif existing[0] != data:
                raise ValueError("stored chunk differs from its source: " + key.hex())
            db.execute("INSERT INTO ordered VALUES (?,?)", (count, key))
            count += 1
            size += len(data)
            digest.update(data)
        after = os.fstat(stream.fileno())
        if size != before.st_size or size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
            raise ValueError("source changed during backup")
        snapshot = digest.hexdigest()
        db.execute("""INSERT INTO snapshots VALUES (?,?) ON CONFLICT(id)
                   DO UPDATE SET size=excluded.size""", (snapshot, size))
        db.execute("DELETE FROM parts WHERE snapshot=?", (snapshot,))
        db.execute("INSERT INTO parts SELECT ?, pos, object FROM ordered", (snapshot,))
        return {"snapshot": snapshot, "size": size, "chunks": count, "added_bytes": added,
                "reused_bytes": size - added}


def reader(repo):
    # SQLite may need to roll back a hot journal on the first read after a crash.
    uri = (repo / "vault.sqlite3").resolve().as_uri() + "?mode=rw"
    return sqlite3.connect(uri, uri=True, timeout=30)


def restore(repo, snapshot, output):
    external_file(repo, output)
    if not re.fullmatch(r"[0-9a-f]{64}", snapshot):
        raise ValueError("expected a lowercase SHA-256 snapshot id")
    with closing(reader(repo)) as db:
        db.execute("BEGIN")
        schema(db)
        row = db.execute("SELECT size FROM snapshots WHERE id=?", (snapshot,)).fetchone()
        if row is None:
            raise ValueError("unknown snapshot: " + snapshot)
        parts = db.execute("""SELECT pos, object, data FROM parts LEFT JOIN objects ON object=hash
                           WHERE snapshot=? ORDER BY pos""", (snapshot,))
        digest = sha256()
        size = 0
        tmp = tempfile.NamedTemporaryFile(dir=output.parent, prefix=".shift-vault-", delete=False)
        try:
            with tmp:
                for position, (stored_pos, key, data) in enumerate(parts):
                    if stored_pos != position or not data or sha256(data).digest() != key:
                        raise ValueError(f"missing or damaged chunk at position {position}")
                    digest.update(data)
                    size += len(data)
                    tmp.write(data)
                if size != row[0] or digest.hexdigest() != snapshot:
                    raise ValueError("snapshot size or full-file SHA-256 mismatch")
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp.name, output)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
    return {"snapshot": snapshot, "size": size}


def snapshots(repo):
    with closing(reader(repo)) as db:
        schema(db)
        return [{"snapshot": key, "size": size} for key, size in
                db.execute("SELECT id,size FROM snapshots ORDER BY id")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("backup").add_argument("source", type=Path)
    commands.add_parser("list")
    recover = commands.add_parser("restore")
    recover.add_argument("snapshot")
    recover.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "backup":
            result = backup(args.repository, args.source)
        elif args.command == "restore":
            result = restore(args.repository, args.snapshot, args.output)
        else:
            result = snapshots(args.repository)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"shift-vault: {error}\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
