import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from grpc_tools import protoc
from probe import message_type, replay


ROOT = Path(__file__).resolve().parent


def compile_set(source, output):
    args = ["protoc", "-I" + str(source.parent), "--include_imports", "--descriptor_set_out=" + str(output)]
    if protoc.main([*args, str(source)]) != 0:
        raise RuntimeError(f"Failed to compile {source}")


class RelayTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.old, self.new = (self.root / f"{version}.pb" for version in ("v1", "v2"))
        for version, target in (("v1", self.old), ("v2", self.new)):
            compile_set(ROOT / "schemas" / version / "parcel.proto", target)
        self.fixture = (ROOT / "receipt.json").read_text("utf8")

    def test_unknown_nested_and_explicit_defaults(self):
        report = replay(self.new, self.old, "parcel.Receipt", self.fixture)
        binary = report["routes"]["binary"]
        self.assertTrue(binary["preserved"])
        self.assertEqual(binary["returned"], json.loads(self.fixture))
        old_view = {"id": "R17", "items": [{"sku": "tea"}, {"sku": "rice"}]}
        self.assertEqual(binary["relay_view"], old_view)
        for route in ("discard_unknown", "relay_json"):
            self.assertFalse(report["routes"][route]["preserved"])
            self.assertEqual(report["routes"][route]["returned"], old_view)

    def test_old_writer_and_absent_new_fields(self):
        fixture = '{"id":"R17","items":[{"sku":"tea"}]}'
        for writer, relay in ((self.old, self.new), (self.new, self.old), (self.new, self.new)):
            self.assertTrue(all(r["preserved"] for r in replay(writer, relay, "parcel.Receipt", fixture)["routes"].values()))

    def test_value_at_relay_can_change_despite_returning_intact(self):
        source = self.root / "gauge.proto"
        sets = []
        for kind in ("uint32", "sint32"):
            source.write_text('syntax="proto3"; message Gauge {' + kind + ' value=1;}', encoding="utf8")
            output = self.root / (kind + ".pb")
            compile_set(source, output)
            sets.append(output)
        route = replay(*sets, "Gauge", '{"value":7}')["routes"]["binary"]
        self.assertTrue(route["preserved"])
        self.assertEqual(route["relay_view"], {"value": -4})
        self.assertEqual(route["returned"], {"value": 7})

    def test_imports_and_cli_contract(self):
        common = self.root / "common.proto"
        common.write_text('syntax="proto3"; message Common {int32 n=1;}', encoding="utf8")
        source = self.root / "event.proto"
        source.write_text('syntax="proto3"; import "common.proto"; message Event {Common value=1;}', encoding="utf8")
        output = self.root / "event.pb"
        compile_set(source, output)
        self.assertEqual(message_type(output, "Event")[0]().value.n, 0)
        base = [sys.executable, ROOT / "probe.py", self.new, self.old, "parcel.Receipt", ROOT / "receipt.json"]
        for route, code in (("binary", 0), ("relay_json", 1)):
            result = subprocess.run([*base, "--require", route], capture_output=True, text=True)
            self.assertEqual(result.returncode, code, result.stderr)
            self.assertIn(route, json.loads(result.stdout)["routes"])
        base[4] = "parcel.Missing"
        self.assertEqual(subprocess.run(base, capture_output=True).returncode, 2)


if __name__ == "__main__":
    unittest.main()
