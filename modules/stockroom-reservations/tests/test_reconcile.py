from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import sqlite3
import subprocess
import sys
from threading import Event

from stockroom.reconcile import reconcile
from stockroom.store import Store


SKU = "KIT-01"
INBOUND = "00000000-0000-4000-8000-000000000001"


def backup(source, destination):
    with (
        closing(sqlite3.connect(source)) as src,
        closing(sqlite3.connect(destination)) as dest,
    ):
        src.backup(dest)


def cli(first, second, sku=SKU):
    return subprocess.run(
        [sys.executable, "-m", "stockroom.reconcile", first, second, sku],
        capture_output=True,
        text=True,
        timeout=15,
    )


def test_original_schema_through_expiry_replays_and_equal_physical_balance(tmp_path):
    opening, current = tmp_path / "original.db", tmp_path / "current.db"
    with closing(sqlite3.connect(opening)) as db:
        db.executescript("""
            CREATE TABLE products(sku TEXT PRIMARY KEY, capacity INTEGER, available INTEGER);
            CREATE TABLE reservations(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER, state TEXT);
            INSERT INTO products VALUES ('KIT-01',20,13), ('OTHER',10,7);
            INSERT INTO reservations VALUES ('old','KIT-01',7,'held'), ('other','OTHER',3,'held');
        """)
    backup(opening, current)
    clock = [100]
    store = Store(current, ttl_seconds=2, clock=lambda: clock[0])
    store.initialize()
    store.reserve("timed", SKU, 6)
    boxes = [("old", "A", 3), ("timed", "A", 2), ("other", "A", 2)]
    store.dispatch_batch("truck", boxes)
    store.dispatch_batch("truck", list(reversed(boxes)))
    store.release_units("timed", "edit", 1)
    for _ in range(2):
        store.restock("old", "A", "received", 1)
        store.apply_receipts([(INBOUND, SKU, 4)])
    clock[0] = 102
    # A read-only reconciliation sees persisted holds and never expires them.
    assert reconcile(opening, current, SKU)["closing"] == {
        "capacity": 20,
        "available": 13,
        "held": 7,
    }
    assert store.progress("timed")["state"] == "expired"
    report = cli(opening, current)
    assert report.returncode == 0, report.stderr
    value = json.loads(report.stdout)
    assert value["opening"] == {"capacity": 20, "available": 13, "held": 7}
    assert value["closing"] == {"capacity": 20, "available": 16, "held": 4}
    assert value["hold_events"] == [
        {"kind": "reserve", "reservation": "timed", "quantity": 6},
        {"kind": "expired", "reservation": "timed", "quantity": 3},
    ]
    assert value["available_changes"] == {
        "reserve": -6,
        "inbound": 4,
        "restock": 1,
        "partial_release": 1,
        "released": 0,
        "expired": 3,
    }
    assert value["expected_available"] == 16 and value["available_difference"] == 0
    assert (
        value["balanced"] and value["capacity_difference"] == 0 and not value["issues"]
    )
    assert value["new_units"] == {
        "dispatch": 5,
        "inbound": 4,
        "restock": 1,
        "release": 1,
    }
    assert value["new_receipts"] == [
        {"kind": "dispatch", "ids": ["old", "A"], "quantity": 3},
        {"kind": "dispatch", "ids": ["timed", "A"], "quantity": 2},
        {"kind": "inbound", "ids": [INBOUND], "quantity": 4},
        {"kind": "release", "ids": ["timed", "edit"], "quantity": 1},
        {"kind": "restock", "ids": ["old", "A", "received"], "quantity": 1},
    ]
    with closing(sqlite3.connect(opening)) as db:
        assert {r[1] for r in db.execute("PRAGMA table_info(reservations)")} == {
            "id",
            "sku",
            "quantity",
            "state",
        }
    assert cli(opening, current, "ABSENT").returncode == 2
    missing = tmp_path / "missing.db"
    assert cli(missing, current).returncode == 2 and not missing.exists()


def test_detect_receipt_edits_even_when_product_totals_still_agree(tmp_path):
    current, opening = tmp_path / "current.db", tmp_path / "opening.db"
    store = Store(current)
    store.initialize()
    store.reserve("r", SKU, 8)
    store.fulfill("r", "A", 2)
    store.fulfill("r", "B", 3)
    backup(current, opening)
    with closing(sqlite3.connect(current)) as db, db:
        db.execute("UPDATE fulfillments SET quantity=5 WHERE shipment_id='A'")
        db.execute("DELETE FROM fulfillments WHERE shipment_id='B'")
    result = cli(opening, current)
    assert result.returncode == 1
    report = json.loads(result.stdout)
    assert report["opening"] == report["closing"] and report["capacity_difference"] == 0
    assert report["issues"] == [
        {
            "reason": "changed_receipt",
            "kind": "dispatch",
            "ids": ["r", "A"],
            "opening": 2,
            "closing": 5,
        },
        {
            "reason": "missing_receipt",
            "kind": "dispatch",
            "ids": ["r", "B"],
            "opening": 3,
            "closing": None,
        },
    ]
    with closing(sqlite3.connect(current)) as db, db:
        db.execute("UPDATE reservations SET shipped=4")
        db.execute("UPDATE products SET capacity=capacity+2, available=available+1")
    issues = reconcile(opening, current, SKU)["issues"]
    assert {"reason": "capacity", "stored": 17, "expected": 15} in issues
    assert {
        "reason": "availability",
        "stored": 13,
        "expected": 14,
        "snapshot": "closing",
    } in issues
    assert {
        "reason": "reservation_counter",
        "reservation": "r",
        "kind": "dispatch",
        "stored": 4,
        "receipted": 5,
        "snapshot": "closing",
    } in issues


def test_writer_commits_between_reads_without_splitting_the_report(
    tmp_path, monkeypatch
):
    current, opening = tmp_path / "current.db", tmp_path / "opening.db"
    store = Store(current)
    store.initialize()
    store.reserve("order", SKU, 6)
    backup(current, opening)
    reading, written = Event(), Event()
    connect = sqlite3.connect

    def gated_connect(path, *args, **kwargs):
        connection = connect(path, *args, **kwargs)
        if path == current.resolve().as_uri() + "?mode=ro":

            def trace(query):
                if "FROM fulfillments f" in query and not reading.is_set():
                    reading.set()
                    written.wait(10)

            connection.set_trace_callback(trace)
        return connection

    monkeypatch.setattr(sqlite3, "connect", gated_connect)
    with ThreadPoolExecutor(max_workers=1) as worker:
        report = worker.submit(reconcile, opening, current, SKU)
        try:
            assert reading.wait(5)
            store.fulfill("order", "A", 4)
            assert not report.done()
        finally:
            written.set()
        before_commit = report.result(timeout=5)
    assert before_commit["balanced"] and before_commit["new_receipts"] == []
    after_commit = reconcile(opening, current, SKU)
    assert after_commit["balanced"] and after_commit["new_units"]["dispatch"] == 4
    assert after_commit["closing"] == {"capacity": 16, "available": 14, "held": 2}


def test_over_return_on_one_box_despite_balanced_physical_units(tmp_path):
    current, opening = tmp_path / "live.db", tmp_path / "opening.db"
    store = Store(current)
    store.initialize()
    store.reserve("r", SKU, 5)
    store.dispatch_batch("truck", [("r", "A", 2), ("r", "B", 3)])
    backup(current, opening)
    store.restock("r", "A", "return", 2)
    with closing(sqlite3.connect(current)) as db, db:
        db.execute("UPDATE shipment_returns SET quantity=3 WHERE return_id='return'")
        db.execute("UPDATE products SET capacity=capacity+1, available=available+1")
    report = reconcile(opening, current, SKU)
    assert report["new_units"]["restock"] == 3 and report["capacity_difference"] == 0
    assert report["issues"] == [
        {
            "reason": "excess_returns",
            "ids": ["r", "A"],
            "dispatched": 2,
            "restocked": 3,
            "snapshot": "closing",
        }
    ]


def test_manual_cancel_full_release_and_fully_shipped_do_not_double_count(tmp_path):
    current, opening = tmp_path / "live.db", tmp_path / "opening.db"
    store = Store(current)
    store.initialize()
    for key in ["manual", "edited", "shipped", "before"]:
        store.reserve(key, SKU, 3)
    store.release("before")
    backup(current, opening)
    store.fulfill("manual", "A", 1)
    store.release("manual")
    store.release("manual")
    store.release_units("edited", "all", 3)
    store.fulfill("shipped", "A", 3)
    report = reconcile(opening, current, SKU)
    assert report["balanced"] and report["expected_available"] == 16
    assert report["hold_events"] == [
        {"kind": "released", "reservation": "manual", "quantity": 2}
    ]
    assert report["available_changes"]["partial_release"] == 3
    assert report["available_changes"]["expired"] == 0
    with closing(sqlite3.connect(current)) as db, db:
        db.execute("DELETE FROM reservations WHERE id='before'")
        db.execute("UPDATE reservations SET quantity=4 WHERE id='manual'")
    issues = reconcile(opening, current, SKU)["issues"]
    assert {"reason": "missing_reservation", "reservation": "before"} in issues
    assert {
        "reason": "changed_order_quantity",
        "reservation": "manual",
        "opening": 3,
        "closing": 4,
    } in issues
