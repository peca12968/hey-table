"""Exchange only new observations after two stations share a count history."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from count_relay import delta, initialize, manifest, merge, record, report, snapshot


def wire_size(value):
    return len((json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8"))


def demonstrate(root):
    east, west = root / "east.db", root / "west.db"
    for path in (east, west):
        initialize(path, "cycle-count")
    for units in range(100):
        record(east, "shared-crate", units, "east")
    merge(west, snapshot(east))
    request = manifest(west)
    record(west, "shared-crate", 103, "west")
    record(east, "shared-crate", 101, "east")
    record(east, "shared-crate", 102, "east")
    record(east, "pallet", 8, "east")
    full = snapshot(east)
    reply = delta(east, request)
    assert merge(west, reply) == {"imported": 3, "known": 0}
    assert merge(west, reply) == {"imported": 0, "known": 3}
    view = report(west)
    disputed = sorted(i["units"] for i in view["batches"]["shared-crate"]["readings"])
    assert disputed == [102, 103] and view["confirmed_units"] == 8
    assert merge(east, delta(west, manifest(east)))["imported"] == 1
    assert report(east) == view
    return {"full_events": len(full["events"]), "delta_events": len(reply["events"]),
            "manifest_bytes": wire_size(request), "delta_bytes": wire_size(reply),
            "full_snapshot_bytes": wire_size(full), "disputed_readings": disputed}


if __name__ == "__main__":
    with TemporaryDirectory() as directory:
        print(json.dumps(demonstrate(Path(directory)), indent=2))
