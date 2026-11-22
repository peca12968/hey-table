"""Exercise restored data through the Stockroom reservation service's store."""
import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from recovery import restore, snapshot


def drill(store_type, root):
    live = store_type(root / "live.db", clock=lambda: 1000)
    live.initialize()
    key = "demo-order-7"
    live.reserve(key, "KIT-01", 7)
    receipt = snapshot(live.path, root / "backup.db")
    live.release(key)
    restored_path = root / "restored.db"
    restore(root / "backup.db", restored_path, receipt["sha256"])
    recovered = store_type(restored_path, clock=lambda: 1000)
    available = recovered.inventory()[0]["available"]
    reservation, created = recovered.reserve(key, "KIT-01", 7)
    replay_available = recovered.inventory()[0]["available"]
    recovered.release(key)
    result = {
        "live_after_release": live.inventory()[0]["available"],
        "restored_available": available,
        "replay_created": created,
        "replay_state": reservation["state"],
        "available_after_replay": replay_available,
        "available_after_release": recovered.inventory()[0]["available"],
    }
    expected = {
        "live_after_release": 20, "restored_available": 13, "replay_created": False,
        "replay_state": "held", "available_after_replay": 13, "available_after_release": 20,
    }
    if result != expected:
        raise RuntimeError(f"Restored service failed the reservation drill: {result}")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom_checkout", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.stockroom_checkout.resolve()))
    from stockroom.store import Store

    with TemporaryDirectory() as temp:
        print(json.dumps(drill(Store, Path(temp)), indent=2))
