from contextlib import closing
import sqlite3
from uuid import uuid4

import pytest

from stockroom.import_receipts import import_receipts
from stockroom.store import Conflict, Store


def test_conflicting_late_receipt_rolls_back_batch_and_preserves_legacy_hold(tmp_path):
    stock = Store(tmp_path / "stock.db", clock=lambda: 1000)
    stock.initialize()
    stock.reserve("held", "KIT-01", 6)
    with closing(stock.connect()) as conn:
        conn.execute("DROP TABLE inbound_receipts")  # Simulate the schema immediately before receipt imports.
    dock = tmp_path / "dock.db"
    old, new = str(uuid4()), str(uuid4())
    with closing(sqlite3.connect(dock, isolation_level=None)) as db:
        db.execute("CREATE TABLE receipts(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER)")
        db.execute("INSERT INTO receipts VALUES (?, 'KIT-01', 2)", (old,))
        assert import_receipts(dock, stock)["units_added"] == 2
        db.execute("DELETE FROM receipts")
        db.executemany("INSERT INTO receipts VALUES (?, 'KIT-01', ?)", [(new, 3), (old, 4)])
        with pytest.raises(Conflict, match=old):
            import_receipts(dock, stock)
        assert stock.inventory()[0] == {"sku": "KIT-01", "capacity": 22, "available": 16}
        db.execute("UPDATE receipts SET quantity=2 WHERE id=?", (old,))
        assert import_receipts(dock, stock) == {"applied": 1, "replayed": 1, "units_added": 3}
        assert stock.progress("held")["held"] == 6


@pytest.mark.parametrize("record", [
    ("invalid", "KIT-01", 1), (str(uuid4()), "kit-01", 1), (str(uuid4()), "KIT-01", 0),
    (str(uuid4()), "KIT-01", 10000), (str(uuid4()), "KIT-01", 1.5),
])
def test_malformed_input_does_not_commit_the_valid_prefix(tmp_path, record):
    stock = Store(tmp_path / "stock.db")
    stock.initialize()
    with pytest.raises(ValueError, match="Invalid inbound receipt"):
        stock.apply_receipts([(str(uuid4()), "KIT-01", 7), record])
    assert stock.inventory()[0]["capacity"] == 20
    with closing(stock.connect()) as db:
        assert db.execute("SELECT count(*) FROM inbound_receipts").fetchone()[0] == 0


def test_source_snapshot_and_capacity_limit(tmp_path):
    stock = Store(tmp_path / "stock.db")
    stock.initialize()
    dock = tmp_path / "dock.db"
    with closing(sqlite3.connect(dock, isolation_level=None)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("CREATE TABLE receipts(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER)")
        writer.execute("BEGIN")
        writer.execute("INSERT INTO receipts VALUES (?, 'KIT-01', 1)", (str(uuid4()),))
        assert import_receipts(dock, stock)["applied"] == 0
        writer.commit()
        with closing(stock.connect()) as db:
            db.execute("UPDATE products SET capacity=?", (2**63 - 1,))
        with pytest.raises(Conflict, match="integer range"):
            import_receipts(dock, stock)
        with closing(stock.connect()) as db:
            assert db.execute("SELECT count(*) FROM inbound_receipts").fetchone()[0] == 0
            db.execute("UPDATE products SET capacity=20")
        assert import_receipts(dock, stock)["units_added"] == 1
    with pytest.raises(ValueError, match="separate"):
        import_receipts(stock.path, stock)


def test_new_wal_commit_during_import_waits_for_next_run(tmp_path, monkeypatch):
    stock = Store(tmp_path / "stock.db")
    dock = tmp_path / "dock.db"
    with closing(sqlite3.connect(dock, isolation_level=None)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("CREATE TABLE receipts(id TEXT PRIMARY KEY, sku TEXT, quantity INTEGER)")
        writer.execute("INSERT INTO receipts VALUES (?, 'KIT-01', 3)", (str(uuid4()),))
        original = stock.apply_receipts

        def append_after_capture(records):
            writer.execute("INSERT INTO receipts VALUES (?, 'KIT-01', 7)", (str(uuid4()),))
            return original(records)

        with monkeypatch.context() as patch:
            patch.setattr(stock, "apply_receipts", append_after_capture)
            assert import_receipts(dock, stock) == {"applied": 1, "replayed": 0, "units_added": 3}
        assert import_receipts(dock, stock) == {"applied": 1, "replayed": 1, "units_added": 7}
        assert stock.inventory()[0]["available"] == 30
