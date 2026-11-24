"""Reproduce concurrent receipt imports with Dock Outbox and a live order."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Barrier
from urllib.request import Request, urlopen
from uuid import uuid4

from stockroom.store import Store


@contextmanager
def receiving_station(checkout, database):
    env = {**os.environ, "PORT": "0", "DOCK_DB": str(database)}
    station = subprocess.Popen(["node", "server.mjs"], cwd=checkout, env=env,
                               stdout=subprocess.PIPE, encoding="utf-8")
    try:
        line = station.stdout.readline().strip()
        if not line.startswith("Dock Outbox http://127.0.0.1:"):
            raise RuntimeError(f"Dock Outbox did not start: {line!r}")
        yield line.removeprefix("Dock Outbox ") + "/api/receipts"
    finally:
        station.terminate()
        station.wait(timeout=10)
        station.stdout.close()


def post(url, units, sku="KIT-01"):
    payload = {"id": str(uuid4()), "sku": sku, "quantity": units}
    request = Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    for status in (201, 200):
        with urlopen(request, timeout=10) as response:
            assert response.status == status and json.load(response) == payload


def drill(checkout, root):
    dock = root / "receipts.sqlite3"
    stock = Store(root / "stockroom.db")
    stock.initialize()
    stock.reserve("order-7", "KIT-01", 7)
    command = [sys.executable, "-m", "stockroom.import_receipts", str(dock), str(stock.path)]

    def invoke():
        return subprocess.run(command, capture_output=True, text=True, timeout=30, cwd=Path(__file__).parent)

    with receiving_station(checkout, dock) as url:
        post(url, 7)
        post(url, 3)
        gate = Barrier(8)

        def compete(_):
            gate.wait(timeout=10)
            result = invoke()
            assert result.returncode == 0, result.stderr
            return json.loads(result.stdout)

        with ThreadPoolExecutor(max_workers=8) as workers:
            reports = list(workers.map(compete, range(8)))
        first = {"applied": 2, "replayed": 0, "units_added": 10}
        replay = {"applied": 0, "replayed": 2, "units_added": 0}
        assert reports.count(first) == 1 and reports.count(replay) == 7, reports
        after_import = stock.inventory()[0]
        assert after_import == {"sku": "KIT-01", "capacity": 30, "available": 23}

        post(url, 4)
        post(url, 2, "TOTE-02")
        failed = invoke()
        assert failed.returncode != 0 and "Unknown inbound SKU: TOTE-02" in failed.stderr
        after_failed_batch = stock.inventory()[0]
        assert after_failed_batch == after_import
        with closing(stock.connect()) as conn:
            assert conn.execute("SELECT COUNT(*) FROM inbound_receipts").fetchone()[0] == 2
            conn.execute("INSERT INTO products VALUES ('TOTE-02', 0, 0)")
        retry = invoke()
        assert retry.returncode == 0, retry.stderr
        assert json.loads(retry.stdout) == {"applied": 2, "replayed": 2, "units_added": 6}
        assert stock.inventory() == [{"sku": "KIT-01", "capacity": 34, "available": 27},
                                     {"sku": "TOTE-02", "capacity": 2, "available": 2}]
        stock.release("order-7")
        final = stock.inventory()
        assert final == [{"sku": "KIT-01", "capacity": 34, "available": 34},
                         {"sku": "TOTE-02", "capacity": 2, "available": 2}]
    return {"competing_imports": len(reports), "after_import": after_import,
            "after_failed_batch": after_failed_batch, "retry": json.loads(retry.stdout), "after_release": final}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dock_checkout", type=Path)
    args = parser.parse_args()
    with TemporaryDirectory() as folder:
        print(json.dumps(drill(args.dock_checkout.resolve(), Path(folder)), indent=2))
