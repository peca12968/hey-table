from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

from recovery import readonly, restore, snapshot


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.live = self.root / "live.db"
        self.backup = self.root / "snapshot.db"
        self.target = self.root / "restored.db"
        self.writer = sqlite3.connect(self.live)
        self.addCleanup(self.writer.close)
        self.writer.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA wal_autocheckpoint=0;
            CREATE TABLE parent (id INTEGER PRIMARY KEY);
            CREATE TABLE child (id INTEGER REFERENCES parent);
            INSERT INTO parent VALUES (1);
            INSERT INTO child VALUES (1);
        """)

    def test_cli_captures_committed_wal_excluding_open_and_later_transactions(self):
        def cli(*args):
            cmd = [sys.executable, str(Path(__file__).with_name("recovery.py")), *map(str, args)]
            return subprocess.run(cmd, capture_output=True, text=True, timeout=15)

        self.writer.execute("INSERT INTO parent VALUES (2)")
        self.assertGreater(Path(str(self.live) + "-wal").stat().st_size, 0)
        call = cli("snapshot", self.live, self.backup)
        self.assertEqual(call.returncode, 0, call.stderr)
        receipt = json.loads(call.stdout)
        self.assertEqual(receipt["bytes"], self.backup.stat().st_size)
        self.writer.commit()
        self.assertEqual(self.writer.execute("SELECT COUNT(*) FROM parent").fetchone(), (2,))
        failed = cli("restore", self.backup, self.target, "--sha256", "0" * 64)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("SHA-256 mismatch", failed.stderr)
        self.assertFalse(self.target.exists())
        call = cli("restore", self.backup, self.target, "--sha256", receipt["sha256"])
        self.assertEqual(call.returncode, 0, call.stderr)
        with closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute("SELECT * FROM parent").fetchall(), [(1,)])
            self.assertEqual(db.execute("SELECT * FROM child").fetchall(), [(1,)])
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone(), ("delete",))

    def test_damaged_copy_is_rejected_before_publication(self):
        receipt = snapshot(self.live, self.backup)
        with self.backup.open("r+b") as stream:
            stream.seek(-1, 2)
            old = stream.read(1)
            stream.seek(-1, 2)
            stream.write(bytes([old[0] ^ 1]))
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            restore(self.backup, self.target, receipt["sha256"])
        self.assertFalse(self.target.exists())

    def test_writer_can_commit_between_backup_steps_without_entering_the_snapshot(self):
        self.writer.execute("CREATE TABLE padding (payload BLOB)")
        self.writer.execute("INSERT INTO padding VALUES (zeroblob(2097152))")
        self.writer.commit()
        commits = []

        def after_step(status, remaining, total):
            if remaining and not commits:
                self.writer.execute("INSERT INTO parent VALUES (42)")
                self.writer.commit()
                commits.append(remaining)

        class ObservedConnection(sqlite3.Connection):
            def backup(self, target, *, pages):
                super().backup(target, pages=pages, progress=after_step)

        def connect(path, **options):
            if path == self.live:
                uri = path.as_uri() + "?mode=ro"
                return sqlite3.connect(uri, uri=True, factory=ObservedConnection)
            return readonly(path, **options)

        with patch("recovery.readonly", side_effect=connect):
            sha = snapshot(self.live, self.backup)["sha256"]
        self.assertTrue(commits)
        restore(self.backup, self.target, sha)
        with closing(readonly(self.target)) as recovered:
            self.assertEqual(recovered.execute("SELECT id FROM parent").fetchall(), [(1,)])
        self.assertEqual(self.writer.execute("SELECT COUNT(*) FROM parent").fetchone(), (2,))

    def test_matching_digest_alone_cannot_validate_a_database(self):
        for data in [b"", b"not a database", b"SQLite format 3\x00" + bytes(512)]:
            with self.subTest(size=len(data)):
                self.backup.write_bytes(data)
                with self.assertRaises((ValueError, sqlite3.DatabaseError)):
                    restore(self.backup, self.target, hashlib.sha256(data).hexdigest())
                self.assertFalse(self.target.exists())

    def test_foreign_key_violation_prevents_snapshot_and_restore(self):
        self.writer.execute("INSERT INTO child VALUES (999)")
        self.writer.commit()
        with self.assertRaisesRegex(ValueError, "Foreign key"):
            snapshot(self.live, self.backup)
        self.assertFalse(self.backup.exists())
        self.writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.backup.write_bytes(self.live.read_bytes())
        with self.assertRaisesRegex(ValueError, "Foreign key"):
            restore(self.backup, self.target, hashlib.sha256(self.backup.read_bytes()).hexdigest())
        self.assertFalse(self.target.exists())

    def test_concurrent_restore_publishes_one_file_and_preserves_existing_files(self):
        sha = snapshot(self.live, self.backup)["sha256"]
        gate = threading.Barrier(4)

        def attempt(_):
            gate.wait(timeout=10)
            try:
                restore(self.backup, self.target, sha)
                return True
            except FileExistsError:
                return False

        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(pool.map(attempt, range(4))), 1)
        self.assertEqual(hashlib.sha256(self.target.read_bytes()).hexdigest(), sha)
        self.target.write_bytes(b"existing destination")
        for action in [lambda: snapshot(self.live, self.target),
                       lambda: restore(self.backup, self.target, sha)]:
            with self.assertRaises(FileExistsError):
                action()
            self.assertEqual(self.target.read_bytes(), b"existing destination")

    def test_orphan_sidecars_and_reserved_names_are_rejected(self):
        sha = snapshot(self.live, self.backup)["sha256"]
        sidecar = Path(str(self.target) + "-wal")
        sidecar.write_bytes(b"previous WAL")
        with self.assertRaisesRegex(ValueError, "sidecar"):
            restore(self.backup, self.target, sha)
        self.assertFalse(self.target.exists())
        with self.assertRaisesRegex(ValueError, "reserved"):
            restore(self.backup, self.root / "other.db-journal", sha)
        self.assertEqual(sidecar.read_bytes(), b"previous WAL")

    def test_missing_or_empty_source_does_not_create_a_backup(self):
        source = self.root / "missing.db"
        with self.assertRaises(sqlite3.OperationalError):
            snapshot(source, self.backup)
        self.assertFalse(source.exists())
        source.touch()
        with self.assertRaisesRegex(ValueError, "no database pages"):
            snapshot(source, self.backup)
        self.assertFalse(self.backup.exists())
