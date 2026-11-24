"""Export a checkout's actual OpenAPI and submit each synthetic request to its ASGI app."""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient


def capture(source, corpus):
    sys.path.insert(0, str(source))
    from stockroom.api import create_app
    from stockroom.store import Store
    statuses = {}
    with TemporaryDirectory() as directory:
        for i, case in enumerate(corpus):
            app = create_app(Path(directory)/f"{i}.db", clock=lambda:100)
            with TestClient(app) as client:
                # Seed an existing hold through storage, then pack two units via the public API.
                # This also represents a hold created before the rehearsal's smaller request limit.
                store = Store(Path(directory)/f"{i}.db", clock=lambda:100)
                store.reserve("demo", "KIT-01", 10)
                assert client.post("/reservations/demo/fulfillments", headers={"Idempotency-Key":"packed"},
                                   json={"quantity":2}).status_code == 201
                response = client.request(case["method"], case["path"], json=case["body"],
                                          headers={"Idempotency-Key":"example"})
                statuses[case["id"]] = response.status_code
                spec = client.get("/openapi.json").json()
    return {"spec":spec, "statuses":statuses}


if __name__ == "__main__":
    print(json.dumps(capture(Path(sys.argv[1]).resolve(), json.loads(Path(sys.argv[2]).read_text()))))
