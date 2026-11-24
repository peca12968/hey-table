"""Replay one ProtoJSON fixture through two versions of a protobuf message."""
import argparse
import json
from pathlib import Path

from google.protobuf import descriptor_pb2, descriptor_pool, json_format, message_factory
from google.protobuf.message import DecodeError


def message_type(path, name):
    files = descriptor_pb2.FileDescriptorSet.FromString(Path(path).read_bytes()).file
    pending = {item.name: item for item in files}
    if len(pending) != len(files):
        raise ValueError("Duplicate descriptor filename")
    pool = descriptor_pool.DescriptorPool()
    loaded = set()
    while pending:
        ready = [item for item in pending.values() if loaded.issuperset(item.dependency)]
        if not ready:
            raise ValueError("Incomplete descriptor set or import cycle; compile with --include_imports")
        for item in ready:
            pool.Add(item)
            loaded.add(item.name)
            del pending[item.name]
    return message_factory.GetMessageClass(pool.FindMessageTypeByName(name)), pool


def replay(writer_set, relay_set, name, fixture):
    writer, writer_pool = message_type(writer_set, name)
    relay, relay_pool = message_type(relay_set, name)
    initial = json_format.Parse(fixture, writer(), descriptor_pool=writer_pool)
    wire = initial.SerializeToString()

    def visible(message, pool):
        return json_format.MessageToDict(message, descriptor_pool=pool)

    expected = visible(initial, writer_pool)
    results = {}
    for route in ("binary", "discard_unknown", "relay_json"):
        try:
            intermediate = relay.FromString(wire)
            seen = visible(intermediate, relay_pool)
            if route == "discard_unknown":
                intermediate.DiscardUnknownFields()
            elif route == "relay_json":
                intermediate = json_format.ParseDict(seen, relay(), descriptor_pool=relay_pool)
            returned = writer.FromString(intermediate.SerializeToString())
            actual = visible(returned, writer_pool)
            results[route] = {"preserved": initial == returned, "relay_view": seen, "returned": actual}
        except (DecodeError, json_format.Error, ValueError) as error:
            results[route] = {"preserved": False, "error": str(error)}
    return {"message": name, "original": expected, "routes": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("writer_set", type=Path)
    parser.add_argument("relay_set", type=Path)
    parser.add_argument("message")
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--require", choices=("binary", "discard_unknown", "relay_json"), action="append", default=[])
    args = parser.parse_args()
    try:
        report = replay(args.writer_set, args.relay_set, args.message, args.fixture.read_text(encoding="utf8"))
    except (OSError, DecodeError, KeyError, ValueError, TypeError, json_format.Error) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(report, indent=2, ensure_ascii=True))
    return int(any(not report["routes"][route]["preserved"] for route in args.require))


if __name__ == "__main__":
    raise SystemExit(main())
