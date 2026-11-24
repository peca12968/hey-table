"""Build and verify a shift handoff with receipts from the real Stockroom API."""

import argparse
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient

from test_docket import SHIFT, keys, require


def demo(source):
    sys.path.insert(0, str(source.resolve()))
    from stockroom.api import create_app

    with TemporaryDirectory() as folder:
        root = Path(folder)
        database = root / "stockroom.db"
        private, public = keys(root, "north")
        documents = []
        with TestClient(create_app(database)) as api:

            def post(path, key, payload):
                result = api.post(path, headers={"Idempotency-Key": key}, json=payload)
                assert result.status_code == 201, result.text

            orders = [("east", 4), ("west", 3), ("south", 3)]
            for order, quantity in orders:
                post("/reservations", order, {"sku": "KIT-01", "quantity": quantity})
                post(
                    f"/reservations/{order}/fulfillments", "box", {"quantity": quantity}
                )
            for batch, entries in [
                ("morning-1", [("east", 2), ("west", 1)]),
                ("morning-2", [("east", 1), ("south", 2)]),
            ]:
                post(
                    "/return-batches",
                    batch,
                    {
                        "boxes": [
                            {
                                "reservation_id": order,
                                "shipment_id": "box",
                                "quantity": units,
                            }
                            for order, units in entries
                        ]
                    },
                )
            assert api.get("/inventory").json()[0]["capacity"] == 16
        with TestClient(create_app(database)) as restarted:
            for batch in ("morning-2", "morning-1"):
                response = restarted.get(f"/return-batches/{batch}")
                assert response.status_code == 200
                path = root / f"{batch}.json"
                path.write_bytes(response.content)
                documents.append(path)
        package = root / "handoff.json"
        require("pack", private, SHIFT, package, *documents)
        private.unlink()
        verified = json.loads(require("verify", public, SHIFT, package))
        assert [verified[key] for key in ("batch_count", "box_count", "units")] == [
            2,
            4,
            6,
        ]
        expected = [json.loads(doc.read_bytes()) for doc in reversed(documents)]
        assert verified["batches"] == expected
        assert [box["returnable_after"] for box in verified["batches"][0]["boxes"]] == [
            2,
            2,
        ]
        assert [box["returnable_after"] for box in verified["batches"][1]["boxes"]] == [
            1,
            1,
        ]
        verified["package_sha256"] = hashlib.sha256(package.read_bytes()).hexdigest()
        return verified


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom", type=Path)
    print(json.dumps(demo(parser.parse_args().stockroom), indent=2))
