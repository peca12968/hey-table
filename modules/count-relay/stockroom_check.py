"""Compare a Count Relay export with a Stockroom physical inventory snapshot."""

import argparse
from collections import defaultdict
import json
from pathlib import Path

from count_relay import label, summarize, unique_keys, validate_snapshot


def inventory_by_sku(snapshot):
    if (not isinstance(snapshot, dict) or set(snapshot) != {"captured_at_ms", "products"}
            or type(snapshot["captured_at_ms"]) is not int or snapshot["captured_at_ms"] < 0
            or not isinstance(snapshot["products"], list)):
        raise ValueError("invalid Stockroom snapshot")
    products = {}
    for product in snapshot["products"]:
        if (not isinstance(product, dict) or set(product) != {"sku", "capacity", "available"}
                or not label(product["sku"])
                or type(product["capacity"]) is not int or type(product["available"]) is not int
                or not 0 <= product["available"] <= product["capacity"] <= 2**63 - 1):
            raise ValueError("invalid Stockroom product")
        sku = product["sku"]
        if sku in products:
            raise ValueError(f"repeated Stockroom SKU: {sku}")
        products[sku] = product
    return products


def compare(count, inventory, manifest):
    validate_snapshot(count)
    products = inventory_by_sku(inventory)
    if (not isinstance(manifest, dict) or set(manifest) != {"session", "batches"}
            or not isinstance(manifest["batches"], dict) or not manifest["batches"]):
        raise ValueError("invalid count manifest")
    if manifest["session"] != count["session"]:
        raise ValueError("manifest belongs to another count session")

    expected = defaultdict(list)
    for batch, sku in sorted(manifest["batches"].items()):
        if not label(batch) or not label(sku):
            raise ValueError("invalid batch or SKU in count manifest")
        if sku not in products:
            raise ValueError(f"unknown Stockroom SKU: {sku}")
        expected[sku].append(batch)

    readings = summarize(count)["batches"]
    unmapped = sorted(readings.keys() - manifest["batches"].keys())
    results = {}
    for sku, batches in sorted(expected.items()):
        missing = [batch for batch in batches if batch not in readings]
        conflicts = [batch for batch in batches if batch in readings and readings[batch]["units"] is None]
        capacity = products[sku]["capacity"]
        counted = None if missing or conflicts or unmapped else sum(readings[batch]["units"] for batch in batches)
        results[sku] = {
            "capacity": capacity,
            "available": products[sku]["available"],
            "counted": counted,
            "variance": None if counted is None else counted - capacity,
            "missing_batches": missing,
            "conflicted_batches": conflicts,
        }
    return {
        "session": count["session"],
        "captured_at_ms": inventory["captured_at_ms"],
        "unmapped_batches": unmapped,
        "products": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("count_export", type=Path)
    parser.add_argument("inventory_snapshot", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    try:
        inputs = [json.loads(path.read_bytes(), object_pairs_hook=unique_keys)
                  for path in (args.count_export, args.inventory_snapshot, args.manifest)]
        result = compare(*inputs)
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, sort_keys=True, indent=2))
    return int(any(product["variance"] != 0 for product in result["products"].values()))


if __name__ == "__main__":
    raise SystemExit(main())
