"""Track one private pickup appointment per restaurant ticket."""

import re
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

from icalendar import Calendar, Event

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
STAMP = re.compile(
    r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)"
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS tickets(
  uid TEXT PRIMARY KEY, store TEXT NOT NULL, number INTEGER NOT NULL, created INTEGER NOT NULL,
  capture INTEGER NOT NULL, earliest INTEGER NOT NULL, latest INTEGER NOT NULL,
  UNIQUE(store,number,created));
CREATE TABLE IF NOT EXISTS revisions(
  uid TEXT NOT NULL REFERENCES tickets(uid), sequence INTEGER NOT NULL,
  status TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, stamp INTEGER NOT NULL,
  PRIMARY KEY(uid,sequence));
"""


def millis(text):
    if not isinstance(text, str) or not STAMP.fullmatch(text):
        raise ValueError("expected an offset-qualified timestamp with seconds")
    delta = datetime.fromisoformat(text) - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000


def natural(value):
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise ValueError("expected a nonnegative integer")
    return value


def proposal(snapshot, estimate, number):
    if (
        not isinstance(snapshot, dict)
        or snapshot.get("format") != "hey-table.station-orders.v1"
    ):
        raise ValueError("expected the full kitchen station export")
    capture = natural(snapshot.get("capturedAt"))
    if not isinstance(estimate, dict) or natural(estimate.get("capturedAt")) != capture:
        raise ValueError(
            "estimate and kitchen snapshot must have the same capture time"
        )
    if not natural(number):
        raise ValueError("expected a positive order number")

    def select(data, field):
        if not isinstance(data.get("orders"), list):
            raise ValueError("expected an orders list")
        rows = [
            row
            for row in data["orders"]
            if isinstance(row, dict)
            and type(row.get(field)) is int
            and row[field] == number
        ]
        if len(rows) != 1:
            raise ValueError(f"expected exactly one order {number} in each source")
        return rows[0]

    order, window = select(snapshot, "id"), select(estimate, "orderId")
    created = natural(order.get("created"))
    if (
        order.get("mode") != "pickup"
        or order.get("status") != "preparing"
        or created > capture
    ):
        raise ValueError("expected a preparing pickup order created by capture time")
    durations, ready = window.get("seconds"), window.get("readyAt")
    if not all(
        isinstance(pair, list) and len(pair) == 2 for pair in (durations, ready)
    ):
        raise ValueError("expected a pair of estimate bounds")
    low, high = (millis(text) for text in ready)
    if low > high or [low, high] != [capture + 1000 * natural(s) for s in durations]:
        raise ValueError("estimate instants disagree with durations")
    return created, capture, low, high


@contextmanager
def transaction(path):
    with closing(sqlite3.connect(path, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript(SCHEMA)
        with db:
            db.execute("BEGIN IMMEDIATE")
            yield db


def latest(db, uid):
    row = db.execute(
        """SELECT r.*,t.number FROM revisions r JOIN tickets t USING(uid)
                        WHERE uid=? ORDER BY sequence DESC LIMIT 1""",
        (uid,),
    ).fetchone()
    if row is None:
        raise KeyError("unknown pickup event")
    return dict(row)


def append(db, uid, sequence, status, start, end):
    db.execute(
        "INSERT INTO revisions VALUES (?,?,?,?,?,?)",
        (uid, sequence, status, start, end, int(time.time())),
    )
    return latest(db, uid)


def propose(path, store, number, snapshot, estimate):
    if not isinstance(store, str) or not store.strip():
        raise ValueError("store identifier is required")
    created, capture, low, high = proposal(snapshot, estimate, number)
    start, end = low // 1000, (high + 999) // 1000
    with transaction(path) as db:
        ticket = db.execute(
            "SELECT * FROM tickets WHERE store=? AND number=? AND created=?",
            (store, number, created),
        ).fetchone()
        if ticket is None:
            uid = str(uuid4())
            db.execute(
                "INSERT INTO tickets VALUES (?,?,?,?,?,?,?)",
                (uid, store, number, created, capture, low, high),
            )
            return append(db, uid, 0, "TENTATIVE", start, end)
        uid = ticket["uid"]
        event = latest(db, uid)
        if capture < ticket["capture"]:
            raise ValueError("stale kitchen snapshot")
        if capture == ticket["capture"] and (low, high) != (
            ticket["earliest"],
            ticket["latest"],
        ):
            raise ValueError("conflicting estimates at the same capture time")
        db.execute(
            "UPDATE tickets SET capture=?,earliest=?,latest=? WHERE uid=?",
            (capture, low, high, uid),
        )
        if event["status"] == "TENTATIVE" and (start, end) != (
            event["start"],
            event["end"],
        ):
            return append(db, uid, event["sequence"] + 1, "TENTATIVE", start, end)
        return event


def revise(path, uid, expected, status, start=None, end=None):
    natural(expected)
    if status == "CONFIRMED":
        low, high = millis(start), millis(end)
        if low % 1000 or high % 1000 or high <= low:
            raise ValueError("confirmation needs a positive interval at whole seconds")
        interval = (low // 1000, high // 1000)
    elif status == "CANCELLED":
        interval = None
    else:
        raise ValueError("unsupported appointment status")
    with transaction(path) as db:
        event = latest(db, uid)
        if expected != event["sequence"]:
            prior = db.execute(
                """SELECT r.*,t.number FROM revisions r JOIN tickets t USING(uid)
                                  WHERE uid=? AND sequence=?""",
                (uid, expected + 1),
            ).fetchone()
            if (
                prior
                and prior["status"] == status
                and (interval is None or interval == (prior["start"], prior["end"]))
            ):
                return dict(prior)
            raise ValueError("appointment revision changed")
        if interval is None:
            interval = (event["start"], event["end"])
        if event["status"] == status and interval == (event["start"], event["end"]):
            return event
        if event["status"] == "CANCELLED":
            raise ValueError("appointment is already cancelled")
        return append(db, uid, expected + 1, status, *interval)


def read_event(path, uid):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        return latest(db, uid)


def calendar_bytes(event):
    calendar = Calendar()
    calendar.add("prodid", "-//peca12968//Pickup Agenda//ZH-TW")
    calendar.add("version", "2.0")
    entry = Event()
    entry.add("uid", event["uid"] + "@pickup-agenda.invalid")
    entry.add("sequence", event["sequence"])
    entry.add("dtstamp", EPOCH + timedelta(seconds=event["stamp"]))
    entry.add("dtstart", EPOCH + timedelta(seconds=event["start"]))
    if event["end"] > event["start"]:
        entry.add("dtend", EPOCH + timedelta(seconds=event["end"]))
    entry.add("summary", f"自取餐點 #{event['number']}")
    entry.add("status", event["status"])
    entry.add("class", "PRIVATE")
    entry.add("transp", "TRANSPARENT")
    calendar.add_component(entry)
    return calendar.to_ical()
