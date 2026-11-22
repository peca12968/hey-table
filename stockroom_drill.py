"""Exercise restored data through the Stockroom reservation service's store."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from recovery import restore_latest


def capture(live, root, name):
    backup, receipt = root / (name + ".db"), root / (name + ".json")
    cmd = [sys.executable, str(Path(__file__).with_name("recovery.py")), "snapshot", live, backup]
    receipt.write_bytes(subprocess.check_output(cmd, timeout=15))
    return backup, receipt


def drill(store_type, root):
    live = store_type(root / "live.db", clock=lambda: 1000)
    live.initialize()
    key = "demo-order-7"
    live.reserve(key, "KIT-01", 7)
    held = capture(live.path, root, "held")
    live.release(key)
    released = capture(live.path, root, "released")
    candidates = [held, released]
    latest_path = root / "latest.db"
    selected = restore_latest(candidates, latest_path)
    latest_available = store_type(latest_path, clock=lambda: 1000).inventory()[0]["available"]

    released[0].write_bytes(b"simulated media damage")
    restored_path = root / "restored.db"
    fallback = restore_latest(candidates, restored_path)
    recovered = store_type(restored_path, clock=lambda: 1000)
    available = recovered.inventory()[0]["available"]
    reservation, created = recovered.reserve(key, "KIT-01", 7)
    replay_available = recovered.inventory()[0]["available"]
    recovered.release(key)
    result = {
        "latest_snapshot": Path(selected["snapshot"]).name,
        "latest_available": latest_available,
        "fallback_snapshot": Path(fallback["snapshot"]).name,
        "skipped": [item["reason"] for item in fallback["skipped"]],
        "live_after_release": live.inventory()[0]["available"],
        "restored_available": available,
        "replay_created": created,
        "replay_state": reservation["state"],
        "available_after_replay": replay_available,
        "available_after_release": recovered.inventory()[0]["available"],
    }
    expected = {
        "latest_snapshot": "released.db", "latest_available": 20,
        "fallback_snapshot": "held.db", "skipped": ["Snapshot SHA-256 mismatch"],
        "live_after_release": 20, "restored_available": 13, "replay_created": False,
        "replay_state": "held", "available_after_replay": 13, "available_after_release": 20,
    }
    if result != expected:
        raise RuntimeError(f"Restored service failed the reservation drill: {result}")
    return {**result, "latest_captured_at": selected["captured_at"],
            "fallback_captured_at": fallback["captured_at"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom_checkout", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.stockroom_checkout.resolve()))
    from stockroom.store import Store

    with TemporaryDirectory() as temp:
        print(json.dumps(drill(Store, Path(temp)), indent=2))
