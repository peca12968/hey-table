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

from recovery import readonly, restore, restore_latest, snapshot


def cli(*args):
    cmd = [sys.executable, str(Path(__file__).with_name("recovery.py")), *map(str, args)]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=15)


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
            return cli("restore", self.backup, self.target, "--sha256", sha)

        with ThreadPoolExecutor(max_workers=4) as pool:
            calls = list(pool.map(attempt, range(4)))
        self.assertCountEqual([call.returncode for call in calls], [0, 1, 1, 1])
        for call in calls:
            if call.returncode:
                self.assertIn(self.target.name, call.stderr)
            else:
                self.assertEqual(json.loads(call.stdout)["sha256"], sha)
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

    def test_inclusive_recovery_window_with_corrupt_and_out_of_window_versions(self):
        older = self.candidate("early", "2026-04-01T03:00:00Z")
        within = self.candidate("candidate", "2026-04-01T04:00:00Z")
        later = self.candidate("late", "2026-04-01T05:00:00Z")
        points = [later, older, within]
        # Both bounds represent exactly the middle snapshot, using different offsets.
        result = restore_latest(points, self.target, "2026-04-01T06:00:00+02:00", "2026-04-01T12:00:00+08:00")
        self.assertEqual(result["snapshot"], str(within[0]))
        self.assertEqual([item["reason"] for item in result["skipped"]], ["after recovery cutoff"])
        within[0].write_bytes(b"damaged")
        dest = self.root / "window.db"
        with self.assertRaisesRegex(ValueError, "before recovery cutoff"):
            restore_latest(points, dest, "2026-04-01T04:00:00Z", "2026-04-01T04:59:59Z")
        self.assertFalse(dest.exists())
        self.assertEqual(restore_latest(points, dest, not_after="2026-04-01T04:59:59Z")["snapshot"], str(older[0]))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            restore_latest(points, self.root / "impossible.db", "2026-04-02T00:00:00Z", "2026-04-01T00:00:00Z")

    def candidate(self, name, when):
        db = self.root / (name + ".db")
        receipt = self.root / (name + ".json")
        record = snapshot(self.live, db)
        # Fix time for deterministic cutoff, offset, and ordering cases.
        record["captured_at"] = when
        receipt.write_text(json.dumps(record), encoding="utf-8")
        return db, receipt

    def test_latest_cli_uses_capture_time_and_restores_last_verified_contents(self):
        old = self.candidate("z", "2026-04-01T12:00:00+08:00")
        self.writer.execute("INSERT INTO parent VALUES (2)")
        self.writer.commit()
        newest = self.candidate("a", "2026-04-01T05:00:00Z")
        missing = self.candidate("b", "2026-04-01T06:00:00Z")
        missing[0].unlink()
        args = ["--candidate", *old, "--candidate", *missing, "--candidate", *newest]
        call = cli("restore-latest", self.target, *args)
        self.assertEqual(call.returncode, 0, call.stderr)
        report = json.loads(call.stdout)
        self.assertEqual(report["snapshot"], str(newest[0]))
        self.assertEqual([x["reason"] for x in report["skipped"]], ["snapshot missing"])
        with closing(readonly(self.target)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM parent").fetchone(), (2,))

        newest[0].write_bytes(b"damaged")
        second = self.root / "fallback.db"
        call = cli("restore-latest", second, *args, "--not-before", "2026-04-01T04:00:00Z")
        self.assertEqual(call.returncode, 0, call.stderr)
        report = json.loads(call.stdout)
        self.assertEqual(report["captured_at"], "2026-04-01T04:00:00+00:00")
        self.assertEqual(report["snapshot"], str(old[0]))
        self.assertEqual([x["reason"] for x in report["skipped"]],
                         ["snapshot missing", "Snapshot SHA-256 mismatch"])
        with closing(readonly(second)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM parent").fetchone(), (1,))

        too_old = self.root / "too-old.db"
        call = cli("restore-latest", too_old, *args, "--not-before", "2026-04-01T04:00:01Z")
        self.assertEqual(call.returncode, 1)
        self.assertIn("before recovery cutoff", call.stderr)
        self.assertFalse(too_old.exists())

    def test_latest_validates_receipts_before_publishing_and_rejects_ties(self):
        new = self.candidate("one", "2026-04-01T04:00:00Z")
        other = self.candidate("two", "2026-04-01T12:00:00+08:00")
        with self.assertRaisesRegex(ValueError, "duplicate capture time"):
            restore_latest([new, other], self.target)
        for bad in [{}, {"captured_at": "2026-03-30T09:00:00"}, {"captured_at": "2026-03-30T09:00:00Z",
                                                                 "sha256": "incomplete"}]:
            other[1].write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "two.json"):
                restore_latest([new, other], self.target)
        self.assertFalse(self.target.exists())

    def test_latest_propagates_destination_errors_without_trying_an_older_snapshot(self):
        old = self.candidate("old", "2026-04-01T04:00:00Z")
        new = self.candidate("new", "2026-04-01T05:00:00Z")
        self.target.write_bytes(b"original destination")
        with patch("recovery.restore", wraps=restore) as calls:
            with self.assertRaises(FileExistsError):
                restore_latest([old, new], self.target)
            self.assertEqual([call.args[0] for call in calls.call_args_list], [new[0]])
        self.assertEqual(self.target.read_bytes(), b"original destination")

    def test_latest_rejects_a_malformed_database_even_with_a_matching_receipt(self):
        old = self.candidate("old", "2026-04-01T04:00:00Z")
        bad, receipt = self.candidate("bad", "2026-04-01T05:00:00Z")
        data = b"SQLite format 3\x00" + bytes(512)
        bad.write_bytes(data)
        record = json.loads(receipt.read_text(encoding="utf-8"))
        record["sha256"] = hashlib.sha256(data).hexdigest()
        receipt.write_text(json.dumps(record), encoding="utf-8")
        result = restore_latest([old, (bad, receipt)], self.target)
        self.assertEqual(result["snapshot"], str(old[0]))
        self.assertEqual([x["snapshot"] for x in result["skipped"]], [str(bad)])
