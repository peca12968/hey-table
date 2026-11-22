"""Run while the local API is listening on port 8000."""
import json
from urllib.request import Request, urlopen
from uuid import uuid4


def call(path, method="GET", payload=None, headers=None):
    req = Request("http://127.0.0.1:8000" + path, method=method,
                  data=json.dumps(payload).encode() if payload else None,
                  headers={"Content-Type": "application/json", **(headers or {})})
    with urlopen(req, timeout=10) as response:
        print(response.status, json.load(response))


key = uuid4().hex
for _ in range(2):
    call("/reservations", "POST", {"sku": "KIT-01", "quantity": 2}, {"Idempotency-Key": key})
call("/inventory")
call(f"/reservations/{key}", "DELETE")
call("/inventory")
