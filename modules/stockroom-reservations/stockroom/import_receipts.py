"""Apply acknowledged Dock Outbox receipts to a Stockroom database."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from .store import Conflict, Missing, Store


def import_receipts(source, store):
    if source.exists() and store.path.exists() and source.samefile(store.path):
        raise ValueError("Use separate Dock Outbox and Stockroom databases")
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as dock:
        dock.execute("PRAGMA trusted_schema=OFF")
        dock.execute("BEGIN")
        records = dock.execute("SELECT id, sku, quantity FROM receipts ORDER BY rowid")
        store.initialize()
        return store.apply_receipts(records)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dock_db", type=Path)
    parser.add_argument("stockroom_db", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(import_receipts(args.dock_db, Store(args.stockroom_db))))
    except (Conflict, Missing, OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"{error}\n")
