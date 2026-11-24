import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
from tempfile import TemporaryDirectory
import unittest


ROOT = Path(__file__).resolve().parent
DLL = ROOT / "bin/Release/net10.0/ReturnDocket.dll"
SHIFT = "north-2026-11-24-am"


def cli(*args):
    return subprocess.run(
        ["dotnet", DLL, *args], capture_output=True, encoding="utf-8", timeout=15
    )


def require(*args):
    result = cli(*args)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout


def keys(folder, name):
    private, public = folder / f"{name}.pem", folder / f"{name}.pub.pem"
    require("generate-key", private)
    public.write_text(require("public-key", private), encoding="ascii")
    return private, public


class DocketTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.private, self.public = keys(self.root, "sender")
        self.source = self.root / "batch.json"
        self.batch = {
            "batch_id": "truck",
            "boxes": [
                {
                    "reservation_id": "east",
                    "shipment_id": "box",
                    "return_id": "truck",
                    "quantity": 2,
                    "returnable_after": 1,
                }
            ],
        }
        self.source.write_text(json.dumps(self.batch), encoding="ascii")
        self.package = self.root / "handoff.json"

    def pack(self):
        return cli("pack", self.private, SHIFT, self.package, self.source)

    def verify(self, public=None, shift=SHIFT):
        return cli("verify", public or self.public, shift, self.package)

    def test_bytes_signature_key_and_shift(self):
        self.assertEqual(self.pack().returncode, 0)
        report = json.loads(self.verify().stdout)
        self.assertEqual(
            report,
            {
                "shift": SHIFT,
                "batch_count": 1,
                "box_count": 1,
                "units": 2,
                "batches": [self.batch],
            },
        )
        _, wrong_key = keys(self.root, "unrelated")
        for result in (self.verify(wrong_key), self.verify(shift="north-evening")):
            self.assertEqual((result.returncode, result.stdout), (1, ""))
        self.assertEqual(self.verify(public=self.private).returncode, 2)
        original = json.loads(self.package.read_bytes())
        payload = json.loads(base64.b64decode(original["payload"]))
        payload["batches"][0]["boxes"][0]["quantity"] = 3
        changed = dict(
            original, payload=base64.b64encode(json.dumps(payload).encode()).decode()
        )
        self.package.write_text(json.dumps(changed), encoding="ascii")
        result = self.verify()
        self.assertEqual((result.returncode, result.stdout), (1, ""))

    def test_invalid_receipts_fail_before_creating_output(self):
        correct = json.dumps(self.batch)
        variants = [
            correct.replace('"quantity": 2', '"quantity": 2, "quantity": 3'),
            correct.replace('"quantity": 2', '"quantity": true'),
            correct.replace('"quantity": 2, ', ""),
            correct.replace('"east"', "null"),
            correct.replace('"return_id": "truck"', '"return_id": "wrong"'),
            json.dumps(dict(self.batch, boxes=self.batch["boxes"] * 2)),
            json.dumps(dict(self.batch, boxes=[None])),
        ]
        for document in variants:
            self.source.write_text(document, encoding="ascii")
            result = self.pack()
            self.assertEqual((result.returncode, result.stdout), (2, ""), document)
            self.assertFalse(self.package.exists())
        self.source.write_text(correct, encoding="ascii")
        result = cli(
            "pack", self.private, SHIFT, self.package, self.source, self.source
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.package.exists())

    def test_concurrent_writers_publish_one_complete_file(self):
        self.package = self.root / "同班退貨.json"
        with ThreadPoolExecutor(max_workers=8) as workers:
            replies = list(workers.map(lambda _: self.pack(), range(8)))
        self.assertEqual(sorted(reply.returncode for reply in replies), [0] + [2] * 7)
        self.assertEqual(self.verify().returncode, 0)
        self.assertEqual(list(self.root.glob(".return-docket-*.tmp")), [])
        original = self.private.read_bytes()
        self.assertEqual(cli("generate-key", self.private).returncode, 2)
        self.assertEqual(self.private.read_bytes(), original)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o600)

    @unittest.skipUnless(
        shutil.which("openssl"),
        "OpenSSL is required for independent signature verification",
    )
    def test_openssl_verifies_dotnet_and_dotnet_verifies_openssl(self):
        self.assertEqual(self.pack().returncode, 0)
        original = json.loads(self.package.read_bytes())
        payload, signature = self.root / "payload.bin", self.root / "signature.bin"
        payload.write_bytes(base64.b64decode(original["payload"]))
        signature.write_bytes(base64.b64decode(original["signature"]))
        subprocess.run(
            [
                "openssl",
                "dgst",
                "-sha256",
                "-verify",
                self.public,
                "-signature",
                signature,
                payload,
            ],
            check=True,
            capture_output=True,
        )
        value = json.loads(payload.read_bytes())
        payload.write_text(json.dumps(value, indent=4), encoding="ascii")
        subprocess.run(
            [
                "openssl",
                "dgst",
                "-sha256",
                "-sign",
                self.private,
                "-out",
                signature,
                payload,
            ],
            check=True,
            capture_output=True,
        )
        for field, path in (("payload", payload), ("signature", signature)):
            original[field] = base64.b64encode(path.read_bytes()).decode()
        self.package.write_text(json.dumps(original), encoding="ascii")
        self.assertEqual(self.verify().returncode, 0)
