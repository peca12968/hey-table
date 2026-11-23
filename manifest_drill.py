"""Send a closed order to the pinned gRPC service before and after a box return."""
import argparse
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
import grpc

from stockroom.api import create_app


def exercise(checkout):
    with TemporaryDirectory() as temp:
        root = Path(temp)
        subprocess.run([sys.executable, "-m", "grpc_tools.protoc", "-I", str(checkout),
                        f"--python_out={root}", f"--grpc_python_out={root}", str(checkout / "manifest.proto")], check=True)
        sys.path[:0] = [str(root), str(checkout)]
        from service import make_server
        from client import csv_rows, stream
        from manifest_pb2_grpc import ManifestIntakeStub

        server, port = make_server(root / "intake.db")
        server.start()
        try:
            with grpc.insecure_channel(f"127.0.0.1:{port}") as channel, TestClient(create_app(root / "stock.db")) as http:
                stub = ManifestIntakeStub(channel)
                key = "shipping-41"
                order = f"/reservations/{key}"
                boxes = order + "/fulfillments"
                url = order + "/dispatch-manifest.csv"
                def upload():
                    response = http.get(url)
                    response.raise_for_status()
                    count = int(response.headers["X-Box-Count"])
                    return stub.Upload(stream(key, count, csv_rows(StringIO(response.text))), timeout=5)
                http.post("/reservations", headers={"Idempotency-Key": key},
                          json={"sku": "KIT-01", "quantity": 8}).raise_for_status()
                for box, amount in (("B", 3), ("A", 2)):
                    http.post(boxes, headers={"Idempotency-Key": box}, json={"quantity": amount}).raise_for_status()
                assert http.get(url).status_code == 409
                http.delete(order).raise_for_status()
                original = upload()
                http.post(boxes + "/B/returns", headers={"Idempotency-Key": "inspection"}, json={"quantity": 1}).raise_for_status()
                replay = upload()
                balances = http.get(boxes).json()
                assert (original.boxes, original.units, original.replayed) == (2, 5, False)
                assert replay.sha256 == original.sha256 and replay.replayed
                assert (balances["returnable"], balances["restocked"], balances["reservation"]["returned"]) == (4, 1, 3)
                return {"boxes": original.boxes, "dispatched": original.units, "restocked": balances["restocked"],
                        "still_with_customer": balances["returnable"], "replayed": replay.replayed}
        finally:
            server.stop(0).wait()
            del sys.path[:2]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest_intake", type=Path)
    print(json.dumps(exercise(parser.parse_args().manifest_intake.resolve()), indent=2))
