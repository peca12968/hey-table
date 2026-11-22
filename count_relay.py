"""Offline batch counts with immutable observations and explicit conflict resolution."""
import argparse
from contextlib import closing, contextmanager
from graphlib import CycleError, TopologicalSorter
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from uuid import uuid4


FORMAT = "count-relay/1"
MANIFEST = "count-relay/manifest/1"
DELTA = "count-relay/delta/1"
ID = re.compile(r"[0-9a-f]{32}")
DIGEST = re.compile(r"[0-9a-f]{64}")


def label(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 120 and value == value.strip()


def quantity(value):
    return type(value) is int and 0 <= value <= 2**31 - 1


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


@contextmanager
def connection(path, *, create=False, write=False):
    uri = path.resolve().as_uri() + ("?mode=rwc" if create else "?mode=rw")
    with closing(sqlite3.connect(uri, uri=True, timeout=10, isolation_level=None)) as db:
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        with db:
            yield db


def initialize(path, session):
    if not label(session):
        raise ValueError("invalid count session")
    with connection(path, create=True, write=True) as db:
        db.execute("CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL)")
        db.execute("INSERT OR IGNORE INTO session VALUES (1, ?)", (session,))
        if session_name(db) != session:
            raise ValueError("database belongs to another count session")
        db.execute("CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, body TEXT NOT NULL)")


def session_name(db):
    return db.execute("SELECT name FROM session WHERE id=1").fetchone()[0]


def observations(db):
    return {key: json.loads(body) for key, body in db.execute("SELECT id, body FROM observations ORDER BY id")}


def heads(events):
    superseded = {parent for item in events.values() for parent in item["parents"]}
    by_batch = {}
    for key in sorted(events.keys() - superseded):
        by_batch.setdefault(events[key]["batch"], {})[key] = events[key]
    return by_batch


def revision(active):
    return hashlib.sha256(canonical(sorted(active)).encode()).hexdigest()


def record(path, batch, units, device, expect=None):
    if not label(batch) or not label(device) or not quantity(units):
        raise ValueError("provide a batch, device and nonnegative 32-bit count")
    with connection(path, write=True) as db:
        active = heads(observations(db)).get(batch, {})
        if expect is not None and expect != revision(active):
            raise ValueError("batch changed since review")
        if expect is None and len({item["units"] for item in active.values()}) > 1:
            raise ValueError("review conflicting counts and provide --expect with the current revision")
        key = uuid4().hex
        item = {"batch": batch, "units": units, "device": device, "parents": sorted(active)}
        db.execute("INSERT INTO observations VALUES (?, ?)", (key, canonical(item)))
        return {"id": key, **item}


def snapshot(path):
    with connection(path) as db:
        return {"format": FORMAT, "session": session_name(db), "events": observations(db)}


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def ensure_receipts(db):
    db.execute("CREATE TABLE IF NOT EXISTS sync_bases (digest TEXT PRIMARY KEY)")


def manifest(path):
    # A receipt and its immutable event set must belong to the same database transaction.
    with connection(path, write=True) as db:
        data = {"format": MANIFEST, "session": session_name(db),
                "known": {k: fingerprint(v) for k, v in observations(db).items()}}
        ensure_receipts(db)
        db.execute("INSERT OR IGNORE INTO sync_bases VALUES (?)", (fingerprint(data),))
        return data


def delta(path, basis):
    if (not isinstance(basis, dict) or set(basis) != {"format", "session", "known"}
            or basis["format"] != MANIFEST or not label(basis["session"]) or not isinstance(basis["known"], dict)):
        raise ValueError("invalid manifest")
    for key, digest in basis["known"].items():
        if (not isinstance(key, str) or not ID.fullmatch(key)
                or not isinstance(digest, str) or not DIGEST.fullmatch(digest)):
            raise ValueError("invalid manifest observation digest")
    source = snapshot(path)
    if source["session"] != basis["session"]:
        raise ValueError("manifest belongs to another count session")
    fresh = {}
    for key, body in source["events"].items():
        if key not in basis["known"]:
            fresh[key] = body
        elif fingerprint(body) != basis["known"][key]:
            raise ValueError("observation ID reused with different content")
    return {"format": DELTA, "session": source["session"], "base": fingerprint(basis), "events": fresh}


def report(path):
    data = snapshot(path)
    batches = {}
    confirmed = 0
    conflicts = 0
    for batch, active in sorted(heads(data["events"]).items()):
        counts = {item["units"] for item in active.values()}
        agreed = counts.pop() if len(counts) == 1 else None
        if agreed is None:
            conflicts += 1
        else:
            confirmed += agreed
        batches[batch] = {"units": agreed, "revision": revision(active),
                          "readings": [{"id": key, "device": item["device"], "units": item["units"]}
                                       for key, item in active.items()]}
    return {"session": data["session"], "confirmed_units": confirmed, "conflicted_batches": conflicts,
            "batches": batches}


def validate_events(events):
    for key, item in events.items():
        if (not isinstance(key, str) or not ID.fullmatch(key) or not isinstance(item, dict)
                or set(item) != {"batch", "units", "device", "parents"} or not label(item["batch"])
                or not label(item["device"]) or not quantity(item["units"])):
            raise ValueError("invalid observation")
        parents = item["parents"]
        if (not isinstance(parents, list) or not all(isinstance(p, str) for p in parents)
                or parents != sorted(set(parents))):
            raise ValueError("invalid parent list")


def validate_history(events):
    for item in events.values():
        if any(p not in events or events[p]["batch"] != item["batch"] for p in item["parents"]):
            raise ValueError("missing or unrelated parent")
    try:
        TopologicalSorter({key: item["parents"] for key, item in events.items()}).prepare()
    except CycleError as exc:
        raise ValueError("cyclic observation history") from exc


def validate_snapshot(data):
    if (not isinstance(data, dict) or set(data) != {"format", "session", "events"} or data["format"] != FORMAT
            or not label(data["session"]) or not isinstance(data["events"], dict)):
        raise ValueError("invalid snapshot envelope")
    validate_events(data["events"])
    validate_history(data["events"])


def merge(path, data):
    partial = isinstance(data, dict) and data.get("format") == DELTA
    if partial:
        if (set(data) != {"format", "session", "events", "base"} or not label(data["session"])
                or not isinstance(data["events"], dict) or not isinstance(data["base"], str)
                or not DIGEST.fullmatch(data["base"])):
            raise ValueError("invalid delta envelope")
        validate_events(data["events"])
    else:
        validate_snapshot(data)
    incoming = data["events"]
    with connection(path, write=True) as db:
        if session_name(db) != data["session"]:
            raise ValueError("snapshot belongs to another count session")
        current = observations(db)
        if partial:
            ensure_receipts(db)
            if not db.execute("SELECT 1 FROM sync_bases WHERE digest=?", (data["base"],)).fetchone():
                raise ValueError("unknown delta base: generate a manifest here or use a full snapshot")
        for key in current.keys() & incoming.keys():
            if current[key] != incoming[key]:
                raise ValueError("observation ID reused with different content")
        fresh = incoming.keys() - current.keys()
        if partial:
            validate_history(current | incoming)
        db.executemany("INSERT INTO observations VALUES (?, ?)", ((k, canonical(incoming[k])) for k in fresh))
        return {"imported": len(fresh), "known": len(incoming) - len(fresh)}


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "record", "status", "export", "manifest", "delta", "merge"):
        cmd = commands.add_parser(name)
        cmd.add_argument("db", type=Path)
        if name == "init":
            cmd.add_argument("session")
        elif name == "record":
            cmd.add_argument("batch")
            cmd.add_argument("units", type=int)
            cmd.add_argument("--device", required=True)
            cmd.add_argument("--expect")
        elif name in ("delta", "merge"):
            cmd.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "init":
            initialize(args.db, args.session)
            result = {"session": args.session}
        elif args.command == "record":
            result = record(args.db, args.batch, args.units, args.device, args.expect)
        elif args.command in ("delta", "merge"):
            data = json.loads(args.file.read_bytes(), object_pairs_hook=unique_keys)
            result = delta(args.db, data) if args.command == "delta" else merge(args.db, data)
        elif args.command == "manifest":
            result = manifest(args.db)
        elif args.command == "status":
            result = report(args.db)
        else:
            result = snapshot(args.db)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
