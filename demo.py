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


def demonstrate_return():
    key = uuid4().hex
    before = next(row for row in call("/inventory")[1] if row["sku"] == "KIT-01")
    call("/reservations", "POST", {"sku": "KIT-01", "quantity": 8}, {"Idempotency-Key": key})
    order = f"/reservations/{key}"
    call(order + "/fulfillments", "POST", {"quantity": 3}, {"Idempotency-Key": "box"})
    call(order, "DELETE")
    box = order + "/fulfillments/box"
    first = call(box + "/returns", "POST", {"quantity": 2}, {"Idempotency-Key": "inspection"})
    replay = call(box + "/returns", "POST", {"quantity": 2}, {"Idempotency-Key": "inspection"})
    assert first[0] == 201 and replay == (200, first[1])
    balance = call(box)[1]
    assert (balance["dispatched"], balance["restocked"], balance["returnable"]) == (3, 2, 1)
    after = next(row for row in call("/inventory")[1] if row["sku"] == "KIT-01")
    assert after["capacity"] == before["capacity"] - 1 and after["available"] == before["available"] - 1


def demonstrate_reduction():
    key = uuid4().hex
    path = f"/reservations/{key}"
    call("/reservations", "POST", {"sku": "KIT-01", "quantity": 8}, {"Idempotency-Key": key})
    call(path + "/fulfillments", "POST", {"quantity": 3}, {"Idempotency-Key": "box"})
    edit = {"Idempotency-Key": "remove-two"}
    first = call(path + "/releases", "POST", {"quantity": 2}, edit)
    assert first[0] == 201 and first[1]["held_after"] == 3
    call(path, "DELETE")
    assert call(path + "/releases", "POST", {"quantity": 2}, edit) == (200, first[1])
    _, progress = call(path)
    assert (progress["shipped"], progress["held"], progress["returned"]) == (3, 0, 5)


def demonstrate_packing():
    key = uuid4().hex
    order = f"/reservations/{key}"
    boxes = order + "/fulfillments"
    call("/reservations", "POST", {"quantity": 10, "sku": "KIT-01"}, {"Idempotency-Key": key})
    for box, units in (("B", 3), ("A", 2)):
        call(boxes, "POST", {"quantity": units}, {"Idempotency-Key": box})
    call(boxes + "/B/returns", "POST", {"quantity": 1}, {"Idempotency-Key": "inspection"})
    call(order, "DELETE")
    _, view = call(boxes)
    assert [box["shipment_id"] for box in view["boxes"]] == ["A", "B"]
    assert (view["reservation"]["returned"], view["reservation"]["shipped"],
            view["restocked"], view["returnable"]) == (5, 5, 1, 4)


def demonstrate_renewal():
    key = uuid4().hex
    path = f"/reservations/{key}"
    _, hold = call("/reservations", "POST", {"sku": "KIT-01", "quantity": 2}, {"Idempotency-Key": key})
    deadline = hold["expires_at_ms"]
    request = {"expected_expires_at_ms": deadline, "extend_seconds": 30}
    headers = {"Idempotency-Key": "payment-pending"}
    first, receipt = call(path + "/renewals", "POST", request, headers)
    assert first == 201 and receipt["expires_at_ms"] == deadline + 30000
    assert call(path + "/renewals", "POST", request, headers) == (200, receipt)
    _, current = call(path)
    assert current["held"] == 2 and current["expires_at_ms"] == receipt["expires_at_ms"]
    call(path, "DELETE")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fulfill", action="store_true", help="ship three units from an eight-unit reservation")
    mode.add_argument("--restock", action="store_true", help="inspect and restock two of three shipped units")
    mode.add_argument("--reduce", action="store_true", help="release two held units after a partial shipment")
    mode.add_argument("--packing", action="store_true", help="reconcile a reservation across two boxes and a return")
    mode.add_argument("--renew", action="store_true", help="extend an active checkout hold and replay its receipt")
    args = parser.parse_args()
    if args.renew:
        demonstrate_renewal()
    elif args.packing:
        demonstrate_packing()
    elif args.reduce:
        demonstrate_reduction()
    elif args.restock:
        demonstrate_return()
    elif args.fulfill:
        demonstrate_fulfillment()
    else:
        key = uuid4().hex
        for _ in range(2):
            call("/reservations", "POST", {"sku": "KIT-01", "quantity": 2}, {"Idempotency-Key": key})
        call("/inventory")
        call(f"/reservations/{key}", "DELETE")
        call("/inventory")
