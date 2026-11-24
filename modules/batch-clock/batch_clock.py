"""Time kitchen batches on individual lanes, calibrate recipes and backtest on later work."""
import argparse
from collections import defaultdict
from contextlib import closing
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import sys
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY NOT NULL, dish TEXT NOT NULL, station TEXT NOT NULL,
    batch_size INTEGER NOT NULL, qty INTEGER NOT NULL, lane INTEGER NOT NULL,
    started INTEGER NOT NULL, ended INTEGER, state TEXT NOT NULL DEFAULT 'active',
    CHECK (qty BETWEEN 1 AND batch_size AND lane >= 1),
    CHECK ((state='active' AND ended IS NULL) OR (state='finished' AND ended IS NOT NULL AND ended>started)
           OR (state='discarded' AND ended IS NOT NULL AND ended>=started))
);
CREATE UNIQUE INDEX IF NOT EXISTS active_lane ON batches(station,lane) WHERE state='active';
CREATE INDEX IF NOT EXISTS lane_history ON batches(station,lane,ended);
"""


def positive(value, field):
    if type(value) is not int or not 1 <= value <= 2**53-1:
        raise ValueError(f"{field} must be a positive safe integer")
    return value


def stamp(value):
    if not isinstance(value, str):
        raise ValueError("expected a timestamp with UTC offset")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.utcoffset() is None or dt.microsecond:
        raise ValueError("timestamps require whole seconds and a UTC offset")
    return int(dt.timestamp())


def read_kitchen(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or not isinstance(data.get("stations"), dict) or not isinstance(data.get("recipes"), dict):
        raise ValueError("expected stations and recipes")
    for count in data["stations"].values():
        positive(count, "station capacity")
    for dish, recipe in data["recipes"].items():
        if not isinstance(recipe, dict) or not isinstance(recipe.get("station"), str) or recipe["station"] not in data["stations"]:
            raise ValueError(f"{dish}: unknown station")
        positive(recipe.get("batchSize"), "batchSize")
        bounds = recipe.get("seconds")
        if not isinstance(bounds, list) or len(bounds) != 2 or positive(bounds[0], "lower seconds") > positive(bounds[1], "upper seconds"):
            raise ValueError(f"{dish}: invalid time interval")
    return data


def event(db, item, kitchen=None):
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
        raise ValueError("expected a batch id")
    key, action = item["id"], item.get("action")
    existing = db.execute("SELECT * FROM batches WHERE id=?", (key,)).fetchone()
    explicit = "at" in item
    at = stamp(item["at"]) if explicit else int(time.time())
    if action == "start":
        dish = item.get("dish")
        qty, lane = positive(item.get("qty"), "qty"), positive(item.get("lane"), "lane")
        if not isinstance(dish, str):
            raise ValueError("expected a dish id")
        if existing:
            if (dish, qty, lane) != (existing["dish"], existing["qty"], existing["lane"]) or (explicit and at != existing["started"]):
                raise ValueError(f"{key}: conflicting start")
            return dict(existing)
        recipe = kitchen["recipes"].get(dish)
        if not recipe or qty > recipe["batchSize"] or lane > kitchen["stations"][recipe["station"]]:
            raise ValueError(f"{key}: invalid dish, batch quantity or lane")
        station = recipe["station"]
        if db.execute("SELECT 1 FROM batches WHERE station=? AND lane=? AND ended IS NULL", (station,lane)).fetchone():
            raise ValueError(f"{station}/{lane}: lane is busy")
        last = db.execute("SELECT MAX(ended) FROM batches WHERE station=? AND lane=?", (station,lane)).fetchone()[0]
        if last is not None and at < last:
            raise ValueError(f"{station}/{lane}: start precedes recorded work")
        db.execute("INSERT INTO batches(id,dish,station,batch_size,qty,lane,started) VALUES (?,?,?,?,?,?,?)",
                   (key,dish,station,recipe["batchSize"],qty,lane,at))
    elif action in ("finish", "discard"):
        if not existing:
            raise ValueError(f"{key}: unknown batch")
        state = "finished" if action=="finish" else "discarded"
        if existing["state"] != "active":
            if existing["state"] != state or (explicit and at != existing["ended"]):
                raise ValueError(f"{key}: conflicting completion")
            return dict(existing)
        if at < existing["started"] or (at == existing["started"] and state=="finished"):
            raise ValueError(f"{key}: invalid elapsed time")
        db.execute("UPDATE batches SET ended=?,state=? WHERE id=?", (at,state,key))
    else:
        raise ValueError("unknown event action")
    return dict(db.execute("SELECT * FROM batches WHERE id=?", (key,)).fetchone())


def score(bounds, samples):
    lo, hi = bounds
    return {"tested":len(samples), "within":sum(lo <= s <= hi for s in samples),
            "early":sum(s < lo for s in samples), "late":sum(s > hi for s in samples),
            "late_seconds":sum(max(0,s-hi) for s in samples), "width_seconds":hi-lo}


def calibrate(db, kitchen, cutoff, minimum):
    positive(minimum, "min-batches")
    training = defaultdict(lambda: defaultdict(list))
    holdout = defaultdict(lambda: defaultdict(list))
    excluded = dict(active=0, discarded=0, changed_recipe=0, crossing_cutoff=0)
    for row in db.execute("SELECT * FROM batches"):
        if row["state"] != "finished":
            excluded[row["state"]] += 1
            continue
        dish = row["dish"]
        recipe = kitchen["recipes"].get(dish)
        if not recipe or (recipe["station"], recipe["batchSize"]) != (row["station"], row["batch_size"]):
            excluded["changed_recipe"] += 1
            continue
        seconds = row["ended"] - row["started"]
        if row["ended"] <= cutoff:
            training[dish][row["qty"]].append(seconds)
        elif row["started"] >= cutoff:
            holdout[dish][row["qty"]].append(seconds)
        else:
            excluded["crossing_cutoff"] += 1
    updated = deepcopy(kitchen)
    audit = {}
    for dish, recipe in updated["recipes"].items():
        baseline = recipe["seconds"]
        groups, bounds = {}, []
        for qty, samples in sorted(training[dish].items()):
            n = len(samples)
            interval = None
            if n >= minimum:
                samples.sort()
                # Nearest-rank empirical P10 and P90, using integer arithmetic.
                interval = [samples[(n-1)//10], samples[(9*n-1)//10]]
                bounds.append(interval)
            groups[qty] = {"count":n, "seconds":interval}
        fallback = recipe["batchSize"] - len(bounds)
        if fallback:
            bounds.append(baseline)
        candidate = [min(pair[0] for pair in bounds), max(pair[1] for pair in bounds)]
        recipe["seconds"] = candidate
        later = holdout[dish]
        samples = [seconds for group in later.values() for seconds in group]
        audit[dish] = {"training_by_qty":groups, "fallback_sizes":fallback,
                       "before":{"seconds":baseline, **score(baseline,samples)},
                       "after":{"seconds":candidate, **score(candidate,samples)},
                       "holdout_by_qty":{qty:{"before":score(baseline,values),"after":score(candidate,values)}
                                         for qty,values in sorted(later.items())}}
    return {"cutoff_epoch_s":cutoff,"min_batches":minimum,"excluded":excluded,"dishes":audit,"kitchen":updated}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    cmd = parser.add_subparsers(dest="command", required=True)
    start = cmd.add_parser("start")
    start.add_argument("id")
    start.add_argument("dish")
    start.add_argument("--qty", type=int, required=True)
    start.add_argument("--lane", type=int, required=True)
    start.add_argument("--at")
    for action in ("finish","discard"):
        sub = cmd.add_parser(action)
        sub.add_argument("id")
        sub.add_argument("--at")
    cmd.add_parser("active")
    replay = cmd.add_parser("import")
    replay.add_argument("events", type=Path)
    fit = cmd.add_parser("calibrate")
    fit.add_argument("--cutoff", required=True)
    fit.add_argument("--min-batches", type=int, default=10)
    fit.add_argument("--format", choices=["report","kitchen"], default="report")
    for sub in (start,replay,fit):
        sub.add_argument("--kitchen", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        kitchen = read_kitchen(args.kitchen) if hasattr(args,"kitchen") else None
        readonly = args.command in ("calibrate","active")
        location = args.db.resolve().as_uri()+"?mode=ro" if readonly else args.db
        with closing(sqlite3.connect(location, timeout=15, uri=readonly)) as db:
            db.row_factory = sqlite3.Row
            if not readonly:
                db.executescript(SCHEMA)
            if args.command == "calibrate":
                result = calibrate(db,kitchen,stamp(args.cutoff),args.min_batches)
                if args.format == "kitchen":
                    result = result["kitchen"]
            elif args.command == "active":
                result = [dict(r) for r in db.execute("SELECT * FROM batches WHERE state='active' ORDER BY station,lane")]
            else:
                with db:
                    db.execute("BEGIN IMMEDIATE")
                    if args.command == "import":
                        count = 0
                        with args.events.open(encoding="utf-8-sig") as stream:
                            for count, line in enumerate(stream, 1):
                                try:
                                    item = json.loads(line)
                                    if not isinstance(item, dict) or "at" not in item:
                                        raise ValueError("imported events require an explicit time")
                                    event(db,item,kitchen)
                                except ValueError as exc:
                                    raise ValueError(f"line {count}: {exc}") from exc
                        result = {"events_read":count}
                    else:
                        item = {k:v for k,v in vars(args).items() if v is not None}
                        result = event(db,{**item,"action":args.command},kitchen)
        print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
