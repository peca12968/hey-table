"""Bring two offline stations together after a warehouse count."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from count_relay import initialize, merge, record, report, snapshot


def demonstrate(root):
    east, west = root / "east.db", root / "west.db"
    for station in (east, west):
        initialize(station, "spring-count")
    record(east, "pallet-A", 12, "east")
    record(west, "pallet-B", 8, "west")
    record(east, "shared-crate", 4, "east")
    record(west, "shared-crate", 6, "west")
    east_copy, west_copy = snapshot(east), snapshot(west)
    merge(east, west_copy)
    merge(west, east_copy)
    held = report(east)
    assert held == report(west)
    assert (held["confirmed_units"], held["conflicted_batches"]) == (20, 1)
    crate = held["batches"]["shared-crate"]
    record(east, "shared-crate", 5, "recount", crate["revision"])
    merge(west, snapshot(east))
    replay = merge(west, west_copy)
    final = report(west)
    assert final == report(east)
    assert (final["confirmed_units"], final["conflicted_batches"]) == (25, 0)
    return {"confirmed_before_recount": held["confirmed_units"],
            "disputed_readings": sorted(r["units"] for r in crate["readings"]),
            "confirmed_after_recount": final["confirmed_units"],
            "observations_added_by_old_snapshot": replay["imported"]}


if __name__ == "__main__":
    with TemporaryDirectory() as temp:
        print(json.dumps(demonstrate(Path(temp)), indent=2))
