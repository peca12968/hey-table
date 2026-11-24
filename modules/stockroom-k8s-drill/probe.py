"""Exercise Stockroom over HTTP from a separate pod on either side of a rollout."""
import json
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request(base, method, path, expected, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = Request(base + path, method=method, data=data,
                  headers={"Content-Type": "application/json", **(headers or {})})
    with urlopen(req, timeout=15) as response:
        if response.status != expected:
            raise ValueError(f"{method} {path}: expected HTTP {expected}, got {response.status}")
        return json.load(response)


def inventory(base, expected):
    # Pod readiness and Service endpoint propagation can finish at different times.
    deadline = time.monotonic() + 25
    while True:
        try:
            products = request(base, "GET", "/inventory", 200)
            break
        except (URLError, TimeoutError) as exc:
            if isinstance(exc, HTTPError) and exc.code not in (502, 503, 504):
                raise
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)
    actual = next(p["available"] for p in products if p["sku"] == "KIT-01")
    if actual != expected:
        raise ValueError(f"Expected {expected} available, found {actual}")
    return actual


def exercise(base, phase):
    before = phase == "before"
    if not before and phase != "after":
        raise ValueError("expected before or after")
    available = inventory(base, 20 if before else 13)
    key = "kind-order-7"
    status = 201 if before else 200
    reservation = request(base, "POST", "/reservations", status,
                          {"sku": "KIT-01", "quantity": 7}, {"Idempotency-Key": key})
    if reservation["state"] != "held" or reservation["id"] != key or reservation["quantity"] != 7:
        raise ValueError(f"Unexpected reservation: {reservation}")
    report = {"initial_available": available, "post_status": status,
              "reservation": reservation, "after_post": inventory(base, 13)}
    if not before:
        released = request(base, "DELETE", f"/reservations/{key}", 200)
        if released["state"] != "released":
            raise ValueError(f"Expected released reservation, got {released}")
        report["after_release"] = inventory(base, 20)
    return report


if __name__ == "__main__":
    print(json.dumps(exercise(sys.argv[1], sys.argv[2])))
