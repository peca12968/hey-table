"""Pack delivery receipts into Avro containers or project a batch into JSON Lines."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
import zlib

from avro import schema
from avro.compatibility import ReaderWriterCompatibilityChecker, SchemaCompatibilityType
from avro.datafile import DataFileReader, DataFileWriter
from avro.errors import AvroException
from avro.io import DatumReader, DatumWriter


def contract(version):
    path = Path(__file__).parent / "schemas" / (version + ".avsc")
    return schema.parse(path.read_text(encoding="utf-8"))


@contextmanager
def atomic_output(destination, inputs):
    for source in inputs:
        if source.resolve() == destination.resolve() or (
            destination.exists() and source.exists() and source.samefile(destination)
        ):
            raise ValueError(f"Output also names an input: {source}")
    temp = NamedTemporaryFile(dir=destination.parent, prefix=f".{destination.name}.",
                              suffix=".part", delete=False)
    staging = Path(temp.name)
    try:
        with temp:
            yield temp
            temp.flush()
            os.fsync(temp.fileno())
        os.replace(staging, destination)
    finally:
        staging.unlink(missing_ok=True)


def pack(source, destination, writer_schema):
    count = 0
    with atomic_output(destination, [source]) as output, source.open(encoding="utf-8") as lines:
        writer = DataFileWriter(output, DatumWriter(), writer_schema, codec="deflate")
        for number, line in enumerate(lines, 1):
            try:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError("expected an object")
                for field in writer_schema.fields:
                    if field.has_default:
                        record.setdefault(field.name, field.default)
                # Python bool subclasses int, while Avro boolean is a distinct type.
                for field in ("received_ms", "package_count"):
                    if isinstance(record.get(field), bool):
                        raise ValueError(f"{field} must be an integer")
                writer.append(record)
            except (ValueError, AvroException) as error:
                raise ValueError(f"{source}, line {number}: {error}") from error
            count += 1
        writer.flush()
    return count


def project(source, reader_schema, output):
    count = 0
    with source.open("rb") as binary:
        reader = DataFileReader(binary, DatumReader(readers_schema=reader_schema))
        writer_schema = reader.datum_reader.writers_schema
        if getattr(writer_schema, "fullname", None) != reader_schema.fullname:
            raise ValueError(f"Expected record {reader_schema.fullname}")
        check = ReaderWriterCompatibilityChecker().get_compatibility(reader_schema, writer_schema)
        if check.compatibility != SchemaCompatibilityType.compatible:
            details = "; ".join(sorted(check.messages)) or str(check.incompatibilities)
            raise ValueError(f"Incompatible writer schema: {details}")

        # An empty container ends with the header's sync marker. Every data block
        # in a nonempty container must also end with that same marker.
        start = binary.tell()
        binary.seek(-len(reader.sync_marker), os.SEEK_END)
        if binary.read() != reader.sync_marker:
            raise ValueError("Incomplete Avro container: final sync marker missing")
        binary.seek(start)
        for record in reader:
            projected = {field.name: record[field.name] for field in reader_schema.fields}
            line = json.dumps(projected, ensure_ascii=False, separators=(",", ":"))
            output.write((line + "\n").encode("utf-8"))
            count += 1
    return count


def export(sources, destination, reader_schema):
    count = 0
    with atomic_output(destination, sources) as output:
        for source in sources:
            try:
                count += project(source, reader_schema, output)
            except (AvroException, OSError, ValueError, EOFError, zlib.error) as error:
                raise ValueError(f"{source}: {error}") from error
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("pack", help="encode UTF-8 JSON Lines into an Avro file")
    write.add_argument("--writer", choices=["v1", "v2"], required=True)
    write.add_argument("source", type=Path)
    read = commands.add_parser("export", help="resolve all input archives against one reader schema")
    read.add_argument("--reader", choices=["v1", "v2"], required=True)
    read.add_argument("sources", nargs="+", type=Path)
    for command in (write, read):
        command.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "pack":
            count = pack(args.source, args.output, contract(args.writer))
        else:
            count = export(args.sources, args.output, contract(args.reader))
    except (ValueError, OSError, AvroException) as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps({"records": count, "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
