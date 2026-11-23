"""Upload to the historical service, reopen its database, and trace an old relay."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

import grpc
from google.protobuf.json_format import MessageToJson
from grpc_tools import protoc
import manifest_pb2 as pb
import manifest_pb2_grpc as rpc
from client import stream
from service import make_server


def compile_schema(directory, output, generate=False):
    args = ["protoc", "-I" + str(directory), "--include_imports", "--descriptor_set_out=" + str(output)]
    if generate:
        args.extend(["--python_out=" + str(directory), "--grpc_python_out=" + str(directory)])
    if protoc.main([*args, str(directory / "manifest.proto")]):
        raise RuntimeError("Unable to compile manifest schema")


def exercise(legacy, probe):
    with TemporaryDirectory() as temp:
        root = Path(temp).resolve()
        db = root / "receipts.db"
        for name in ("service.py", "manifest.proto"):
            shutil.copyfile(legacy / name, root / name)
        old, new = root / "old.pb", root / "new.pb"
        compile_schema(root, old, generate=True)
        compile_schema(Path(__file__).resolve().parent, new)
        # The historical server imports its own generated stubs in the child interpreter.
        script = ("from service import make_server; import sys; "
                  "server, port = make_server(sys.argv[1]); server.start(); "
                  "print(port, flush=True); sys.stdin.readline(); server.stop(0).wait()")
        process = subprocess.Popen([sys.executable, "-c", script, str(db)], cwd=root,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        boxes = [("A", 3), ("B", 5)]
        try:
            port = int(process.stdout.readline())
            with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
                previous = rpc.ManifestIntakeStub(channel).Upload(stream("legacy", 2, boxes), timeout=10)
                assert not previous.HasField("uniform_box_units")
        finally:
            try:
                process.communicate("\n", timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        assert process.returncode == 0
        server, port = make_server(db)
        server.start()
        try:
            with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
                stub = rpc.ManifestIntakeStub(channel)
                restored = stub.Lookup(pb.ManifestKey(manifest_id="legacy"), timeout=5)
                replay = stub.Upload(stream("legacy", 2, reversed(boxes)), timeout=5)
                equal = stub.Upload(stream("equal", 2, [("A", 4), ("B", 4)]), timeout=5)
                assert equal.HasField("uniform_box_units") and equal.uniform_box_units
                assert replay.replayed and replay.sha256 == restored.sha256 == previous.sha256
                for result in (restored, replay):
                    assert result.HasField("uniform_box_units") and not result.uniform_box_units
                fixture = root / "receipt.json"
                fixture.write_text(MessageToJson(restored), encoding="utf8")
                report = json.loads(subprocess.check_output([sys.executable, probe, new, old,
                                                            "intake.v1.Receipt", fixture, "--require", "binary"]))
                assert report["routes"]["binary"]["returned"]["uniformBoxUnits"] is False
                assert "uniformBoxUnits" not in report["routes"]["relay_json"]["returned"]
                return {"legacy_present": previous.HasField("uniform_box_units"),
                        "after_upgrade": restored.uniform_box_units, "equal_boxes": equal.uniform_box_units,
                        "preserved_by": [key for key, value in report["routes"].items() if value["preserved"]]}
        finally:
            server.stop(0).wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legacy_checkout", type=Path)
    parser.add_argument("probe", type=Path)
    args = parser.parse_args()
    print(json.dumps(exercise(args.legacy_checkout.resolve(), args.probe.resolve()), indent=2))
