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
ID = re.compile(r"[0-9a-f]{32}")


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


def validate_snapshot(data):
    if (not isinstance(data, dict) or set(data) != {"format", "session", "events"}
            or data["format"] != FORMAT or not label(data["session"]) or not isinstance(data["events"], dict)):
        raise ValueError("invalid snapshot envelope")
    events = data["events"]
    for key, item in events.items():
        if (not isinstance(key, str) or not ID.fullmatch(key) or not isinstance(item, dict)
                or set(item) != {"batch", "units", "device", "parents"} or not label(item["batch"])
                or not label(item["device"]) or not quantity(item["units"])):
            raise ValueError("invalid observation")
        parents = item["parents"]
        if (not isinstance(parents, list) or not all(isinstance(p, str) for p in parents)
                or parents != sorted(set(parents))):
            raise ValueError("invalid parent list")
    for item in events.values():
        if any(p not in events or events[p]["batch"] != item["batch"] for p in item["parents"]):
            raise ValueError("missing or unrelated parent")
    try:
        TopologicalSorter({key: item["parents"] for key, item in events.items()}).prepare()
    except CycleError as exc:
        raise ValueError("cyclic observation history") from exc


def merge(path, data):
    validate_snapshot(data)
    with connection(path, write=True) as db:
        if session_name(db) != data["session"]:
            raise ValueError("snapshot belongs to another count session")
        current = observations(db)
        incoming = data["events"]
        for key in current.keys() & incoming.keys():
            if current[key] != incoming[key]:
                raise ValueError("observation ID reused with different content")
        fresh = incoming.keys() - current.keys()
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
    for name in ("init", "record", "status", "export", "merge"):
        cmd = commands.add_parser(name)
        cmd.add_argument("db", type=Path)
        if name == "init":
            cmd.add_argument("session")
        elif name == "record":
            cmd.add_argument("batch")
            cmd.add_argument("units", type=int)
            cmd.add_argument("--device", required=True)
            cmd.add_argument("--expect")
        elif name == "merge":
            cmd.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "init":
            initialize(args.db, args.session)
            result = {"session": args.session}
        elif args.command == "record":
            result = record(args.db, args.batch, args.units, args.device, args.expect)
        elif args.command == "merge":
            result = merge(args.db, json.loads(args.file.read_bytes(), object_pairs_hook=unique_keys))
        elif args.command == "status":
            result = report(args.db)
        else:
            result = snapshot(args.db)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
