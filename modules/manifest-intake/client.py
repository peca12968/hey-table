"""Send a box_id,units CSV to a Manifest Intake service."""
import argparse
import csv
import json
from pathlib import Path
import sys

import grpc
from google.protobuf.json_format import MessageToDict
import manifest_pb2 as pb
import manifest_pb2_grpc as rpc


def stream(key, expected, rows):
    yield pb.Part(header=pb.Header(manifest_id=key, expected_boxes=expected))
    for box_id, units in rows:
        yield pb.Part(box=pb.Box(box_id=box_id, units=units))


def csv_rows(source):
    reader = csv.DictReader(source)
    if reader.fieldnames != ["box_id", "units"]:
        raise ValueError("expected box_id,units CSV header")
    for row in reader:
        if None in row or row["units"] is None:
            raise ValueError(f"invalid CSV row {reader.line_num}")
        yield row["box_id"], int(row["units"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", default="127.0.0.1:50051")
    parser.add_argument("manifest_id")
    parser.add_argument("expected_boxes", type=int)
    parser.add_argument("csv", type=Path)
    args = parser.parse_args()
    try:
        with grpc.insecure_channel(args.address) as channel, args.csv.open(encoding="utf-8-sig", newline="") as source:
            result = rpc.ManifestIntakeStub(channel).Upload(stream(args.manifest_id, args.expected_boxes, csv_rows(source)),
                                                            timeout=30)
            print(json.dumps(MessageToDict(result, preserving_proto_field_name=True, always_print_fields_with_no_presence=True)))
    except grpc.RpcError as exc:
        sys.exit(f"{exc.code().name}: {exc.details()}")
