from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from random import Random
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from textwrap import dedent
import unittest
from unittest.mock import patch

from demo import demonstrate
from vault import backup, chunks, MAX_CHUNK, MIN_CHUNK, restore, snapshots


class VaultTests(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.repo = self.work / "repo"
        self.source = self.work / "export.bin"
        self.output = self.work / "restored.bin"

    def database(self):
        return sqlite3.connect(self.repo / "vault.sqlite3")

    def cli(self, *args):
        return subprocess.run([sys.executable, str(Path(__file__).with_name("vault.py")),
                               str(self.repo), *map(str, args)], capture_output=True, text=True)

    def test_shifted_file_and_repeated_backup(self):
        self.assertEqual(demonstrate(self.work), {
            "size_after": 1048597, "fixed_added": 1048597, "content_added": 3665,
            "content_reused": 1044932, "repeat_added": 0, "verified_versions": 2})

    def test_boundaries_are_stable_across_read_sizes(self):
        data = Random(7).randbytes(90000)
        reference = list(chunks(BytesIO(data)))
        for size in (1, 37, 2048, 65536):
            self.assertEqual(list(chunks(BytesIO(data), size)), reference)
        for size in (0, 1, MIN_CHUNK - 1, MIN_CHUNK, MAX_CHUNK, MAX_CHUNK * 3 + 1, len(data)):
            parts = list(chunks(BytesIO(data[:size])))
            self.assertEqual(b"".join(parts), data[:size])
            self.assertTrue(all(MIN_CHUNK <= len(p) <= MAX_CHUNK for p in parts[:-1]))
            self.assertTrue(all(0 < len(p) <= MAX_CHUNK for p in parts))

    def test_cli_empty_binary_and_listing(self):
        items = []
        for data in (b"", bytes(range(256)) * 100):
            self.source.write_bytes(data)
            proc = self.cli("backup", self.source)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            snapshot = sha256(data).hexdigest()
            self.assertEqual(json.loads(proc.stdout)["snapshot"], snapshot)
            items.append({"snapshot": snapshot, "size": len(data)})
            self.assertEqual(self.cli("restore", snapshot, self.output).returncode, 0)
            self.assertEqual(self.output.read_bytes(), data)
        self.assertCountEqual(json.loads(self.cli("list").stdout), items)
        self.assertNotEqual(self.cli("restore", "0" * 64, self.output).returncode, 0)
        self.assertEqual(self.output.read_bytes(), data)

    def test_late_damaged_chunk_rolls_back_new_objects_and_keeps_output(self):
        data = Random(33).randbytes(200000)
        self.source.write_bytes(data)
        version = backup(self.repo, self.source)["snapshot"]
        with closing(self.database()) as db, db:
            key, = db.execute("SELECT object FROM parts ORDER BY pos DESC LIMIT 1").fetchone()
            db.execute("UPDATE objects SET data=x'00' WHERE hash=?", (key,))
            before, = db.execute("SELECT count(*) FROM objects").fetchone()
        self.source.write_bytes(b"new header\n" + data)
        with self.assertRaisesRegex(ValueError, "stored chunk differs"):
            backup(self.repo, self.source)
        with closing(self.database()) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM objects").fetchone()[0], before)
        self.assertEqual(len(snapshots(self.repo)), 1)
        self.output.write_bytes(b"keep previous export")
        with self.assertRaisesRegex(ValueError, "damaged chunk"):
            restore(self.repo, version, self.output)
        self.assertEqual(self.output.read_bytes(), b"keep previous export")
        self.assertFalse(list(self.work.glob(".shift-vault-*")))

    def test_wrong_manifest_with_valid_chunks_fails_full_file_check(self):
        self.source.write_bytes(Random(12).randbytes(120000))
        version = backup(self.repo, self.source)["snapshot"]
        with closing(self.database()) as db, db:
            db.execute("UPDATE parts SET pos=CASE pos WHEN 0 THEN -1 WHEN 1 THEN -2 END WHERE pos IN (0,1)")
            db.execute("UPDATE parts SET pos=CASE pos WHEN -1 THEN 1 WHEN -2 THEN 0 END WHERE pos<0")
        with self.assertRaisesRegex(ValueError, "full-file"):
            restore(self.repo, version, self.output)
        self.assertFalse(self.output.exists())

    def test_process_exit_mid_backup_preserves_previous_snapshot(self):
        old = b"previous completed export"
        self.source.write_bytes(old)
        previous = backup(self.repo, self.source)
        self.source.write_bytes(Random(39).randbytes(300000))
        program = dedent("""
            import os, sys, vault
            from pathlib import Path
            connect = vault.sqlite3.connect
            def small_cache(*args, **kwargs):
                db = connect(*args, **kwargs)
                db.execute("PRAGMA cache_size=8")
                return db
            vault.sqlite3.connect = small_cache
            original = vault.chunks
            def interrupted(stream):
                for index, chunk in enumerate(original(stream)):
                    if index == 25:
                        os._exit(37)
                    yield chunk
            vault.chunks = interrupted
            vault.backup(Path(sys.argv[1]), Path(sys.argv[2]))
        """)
        crash = subprocess.run([sys.executable, "-c", program, str(self.repo), str(self.source)],
                               cwd=Path(__file__).parent)
        self.assertEqual(crash.returncode, 37)
        self.assertEqual(snapshots(self.repo), [{"snapshot": previous["snapshot"], "size": len(old)}])
        restore(self.repo, previous["snapshot"], self.output)
        self.assertEqual(self.output.read_bytes(), old)
        retry = backup(self.repo, self.source)
        self.assertEqual(retry["added_bytes"], self.source.stat().st_size)
        restore(self.repo, retry["snapshot"], self.output)
        self.assertEqual(self.output.read_bytes(), self.source.read_bytes())

    def test_concurrent_backups_publish_one_set_of_objects(self):
        data = Random(77).randbytes(220000)
        self.source.write_bytes(data)
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(lambda _: self.cli("backup", self.source), range(2)))
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(json.loads(p.stdout)["added_bytes"] for p in results), [0, len(data)])
        self.assertEqual(len(snapshots(self.repo)), 1)
        restore(self.repo, sha256(data).hexdigest(), self.output)
        self.assertEqual(self.output.read_bytes(), data)

    def test_changed_source_and_repository_overlap(self):
        self.source.write_bytes(b"initial contents")

        def mutate(stream):
            yield stream.read()
            with self.source.open("ab") as writer:
                writer.write(b"appended")

        with patch("vault.chunks", mutate), self.assertRaisesRegex(ValueError, "source changed"):
            backup(self.repo, self.source)
        version = backup(self.repo, self.source)["snapshot"]
        with self.assertRaisesRegex(ValueError, "outside"):
            restore(self.repo, version, self.repo / "vault.sqlite3")
        with self.assertRaisesRegex(ValueError, "outside"):
            backup(self.repo, self.repo / "vault.sqlite3")
        self.assertEqual(len(snapshots(self.repo)), 1)


if __name__ == "__main__":
    unittest.main()
