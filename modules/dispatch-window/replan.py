"""Capture Stockroom holds and plan the remaining boxes for a new truck window."""

import argparse
from http.client import HTTPException
import json
from pathlib import Path
import sys

from dispatch import MAX_ORDERS, indexed, integer, plan
from execute import stockroom_client


WINDOW_FIELDS = {"start_ms", "cutoff_ms", "stations", "station_ready_ms", "station_pauses"}


def replan(manifest, window, request):
    if not isinstance(window, dict) or window.keys() - WINDOW_FIELDS:
        raise ValueError("the truck window must contain only start, cutoff and station settings")
    work = manifest["work"]
    orders = indexed(work, "reservation_id")
    if not 1 <= len(orders) <= MAX_ORDERS:
        raise ValueError(f"provide 1 to {MAX_ORDERS} orders in the packing manifest")

    stations = integer(window.get("stations", 1), "stations", 1, 2)
    requested = integer(window["start_ms"], "start_ms") if "start_ms" in window else None
    cutoff = integer(window["cutoff_ms"], "cutoff_ms", 1 if requested is None else requested + 1)
    status, snapshot = request("/packing-snapshots", {"reservation_ids": sorted(orders)})
    if status != 200:
        raise ValueError(f"Stockroom packing snapshot failed (HTTP {status})")
    captured = integer(snapshot["captured_at_ms"], "captured_at_ms")
    start = captured if requested is None else requested
    if start < captured:
        raise ValueError("start_ms predates the Stockroom snapshot; omit it to plan from the snapshot")
    if cutoff <= start:
        raise ValueError("the new truck cutoff must follow the planning start")
    settings = {field: window[field] for field in ("station_ready_ms", "station_pauses") if field in window}
    document = {**settings, "work": work, "holds": snapshot["holds"], "captured_at_ms": captured,
                "start_ms": start, "cutoff_ms": cutoff}
    return {**plan(document, resume=True, stations=stations), "captured_at_ms": captured}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Packing manifest containing the complete work and box IDs")
    parser.add_argument("window", type=Path, help="New truck timing and packing-station settings")
    parser.add_argument("--stockroom", required=True, help="Stockroom HTTP(S) base URL")
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
        window = json.loads(args.window.read_text(encoding="utf-8-sig"))
        result = replan(manifest, window, stockroom_client(args.stockroom))
    except (OSError, HTTPException, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
