"""Run while the local API is listening on port 8000."""
import json
import argparse
from urllib.request import Request, urlopen
from uuid import uuid4


def call(path, method="GET", payload=None, headers=None):
    req = Request("http://127.0.0.1:8000" + path, method=method,
                  data=json.dumps(payload).encode() if payload else None,
                  headers={"Content-Type": "application/json", **(headers or {})})
    with urlopen(req, timeout=10) as response:
        body = json.load(response)
        print(response.status, body)
        return response.status, body


def demonstrate_fulfillment():
    key = uuid4().hex
    before = next(row for row in call("/inventory")[1] if row["sku"] == "KIT-01")
    call("/reservations", "POST", {"sku": "KIT-01", "quantity": 8}, {"Idempotency-Key": key})
    path = f"/reservations/{key}"
    box = {"Idempotency-Key": "first-box"}
    first, receipt = call(path + "/fulfillments", "POST", {"quantity": 3}, box)
    replay, duplicate = call(path + "/fulfillments", "POST", {"quantity": 3}, box)
    assert (first, replay) == (201, 200) and receipt == duplicate and receipt["held_after"] == 5
    call(path, "DELETE")
    _, progress = call(path)
    assert (progress["shipped"], progress["held"], progress["returned"]) == (3, 0, 5)
    after = next(row for row in call("/inventory")[1] if row["sku"] == "KIT-01")
    assert after["capacity"] == before["capacity"] - 3 and after["available"] == before["available"] - 3


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fulfill", action="store_true", help="ship three units from an eight-unit reservation")
    if parser.parse_args().fulfill:
        demonstrate_fulfillment()
    else:
        key = uuid4().hex
        for _ in range(2):
            call("/reservations", "POST", {"sku": "KIT-01", "quantity": 2}, {"Idempotency-Key": key})
        call("/inventory")
        call(f"/reservations/{key}", "DELETE")
        call("/inventory")
