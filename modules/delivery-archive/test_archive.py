import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

import fastavro


ROOT = Path(__file__).resolve().parent
V1 = json.loads((ROOT / "schemas/v1.avsc").read_text(encoding="utf-8"))
V2 = json.loads((ROOT / "schemas/v2.avsc").read_text(encoding="utf-8"))
OLD = {"event_id": "R-1", "shipment_id": "S-2", "station": "台中", "received_ms": 1763942400000}
NEW = {**OLD, "event_id": "R-2", "dock": "B2", "package_count": 4}


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)
        self.output = self.path / "receipts.jsonl"

    def cli(self, *args, success=True):
        result = subprocess.run([sys.executable, str(ROOT / "archive.py"), *map(str, args)],
                                cwd=self.path, capture_output=True,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(result.returncode, 0 if success else 2, result.stderr)
        if success:
            return json.loads(result.stdout)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"Traceback", result.stderr)
        return result.stderr.decode("utf-8")

    def external_file(self, name, writer_schema, records):
        archive = self.path / name
        with archive.open("wb") as binary:
            fastavro.writer(binary, writer_schema, records, codec="deflate", sync_interval=32)
        return archive

    def read_output(self):
        return [json.loads(line) for line in self.output.read_text(encoding="utf-8").splitlines()]

    def test_four_schema_pairs_across_two_implementations(self):
        for writer, record in [("v1", OLD), ("v2", NEW)]:
            source = self.path / "source.jsonl"
            source.write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
            packed = self.path / "external read.avro"
            self.assertEqual(self.cli("pack", "--writer", writer, source, "-o", packed)["records"], 1)
            self.assertEqual(packed.read_bytes()[:4], b"Obj\x01")
            external = self.external_file("external write.avro", V1 if writer == "v1" else V2, [record])
            for reader, reader_schema in [("v1", V1), ("v2", V2)]:
                with self.subTest(writer=writer, reader=reader):
                    expected = dict(record)
                    if reader == "v1":
                        expected = {key: record[key] for key in OLD}
                    elif writer == "v1":
                        expected.update(dock=None, package_count=1)
                    with packed.open("rb") as binary:
                        self.assertEqual(list(fastavro.reader(binary, reader_schema)), [expected])
                    self.cli("export", "--reader", reader, external, "-o", self.output)
                    self.assertEqual(self.read_output(), [expected])

    def test_mixed_archives_preserve_all_rows_and_repeat_byte_for_byte(self):
        first = self.external_file("morning.avro", V1, [OLD] * 9)
        second = self.external_file("evening.avro", V2, [NEW])
        args = ("export", "--reader", "v2", first, second, "-o", self.output)
        self.assertEqual(self.cli(*args)["records"], 10)
        self.assertEqual(self.read_output(), [{**OLD, "dock": None, "package_count": 1}] * 9 + [NEW])
        previous = self.output.read_bytes()
        self.cli(*args)
        self.assertEqual(self.output.read_bytes(), previous)

    def test_incompatible_empty_writer_is_rejected_before_publishing_batch(self):
        valid = self.external_file("first.avro", V1, [OLD])
        self.cli("export", "--reader", "v2", valid, "-o", self.output)
        previous = self.output.read_bytes()
        changed = json.loads(json.dumps(V1))
        changed["fields"][-1]["type"] = "string"
        broken = self.external_file("incompatible.avro", changed, [])
        message = self.cli("export", "--reader", "v2", valid, broken, "-o", self.output, success=False)
        self.assertIn("incompatible.avro", message)
        self.assertIn("Incompatible writer schema", message)
        self.assertEqual(self.output.read_bytes(), previous)
        self.assertFalse(list(self.path.glob("*.part")))

    def test_truncated_tail_in_second_archive_keeps_old_output(self):
        valid = self.external_file("valid.avro", V2, [NEW])
        self.cli("export", "--reader", "v2", valid, "-o", self.output)
        previous = self.output.read_bytes()
        cut = self.external_file("cut.avro", V1, [OLD])
        cut.write_bytes(cut.read_bytes()[:-1])
        self.cli("export", "--reader", "v2", valid, cut, "-o", self.output, success=False)
        self.assertEqual(self.output.read_bytes(), previous)
        fresh = self.path / "new-output.jsonl"
        self.cli("export", "--reader", "v2", valid, cut, "-o", fresh, success=False)
        self.assertFalse(fresh.exists())

    def test_pack_defaults_and_invalid_second_line(self):
        source = self.path / "records.jsonl"
        source.write_text(json.dumps(OLD) + "\n", encoding="utf-8")
        packed = self.path / "packed.avro"
        self.cli("pack", "--writer", "v2", source, "-o", packed)
        with packed.open("rb") as stream:
            self.assertEqual(list(fastavro.reader(stream)), [{**OLD, "dock": None, "package_count": 1}])
        previous = packed.read_bytes()
        for bad in [{"extra": "unknown", **OLD}, {**OLD, "package_count": True}, {"bad": 1}]:
            source.write_text(json.dumps(OLD) + "\n" + json.dumps(bad), encoding="utf-8")
            self.assertIn("line 2", self.cli("pack", "--writer", "v2", source, "-o", packed, success=False))
            self.assertEqual(packed.read_bytes(), previous)

    def test_empty_compatible_archive_and_input_output_alias(self):
        empty = self.external_file("empty.avro", V1, [])
        self.assertEqual(self.cli("export", "--reader", "v2", empty, "-o", self.output)["records"], 0)
        self.assertEqual(self.output.read_bytes(), b"")
        original = empty.read_bytes()
        self.cli("export", "--reader", "v1", empty, "-o", empty, success=False)
        self.assertEqual(empty.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
