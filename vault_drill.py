"""Run end-to-end SQLite recovery checks against a real Shift Vault checkout."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
from random import Random
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


class VaultRecoveryTests(unittest.TestCase):
    checkout = Path(__file__).resolve().parent.parent / "shift-vault"

    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = self.root / "store"
        self.live = self.root / "live.db"
        self.writer = sqlite3.connect(self.live)
        self.addCleanup(self.writer.close)
        self.writer.execute("PRAGMA page_size=4096")
        self.assertEqual(self.writer.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
        self.writer.execute("PRAGMA wal_autocheckpoint=0")
        self.writer.execute("CREATE TABLE scans(id INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
        rng = Random(83)
        self.rows = [rng.randbytes(400) for _ in range(2000)]
        self.writer.executemany("INSERT INTO scans(payload) VALUES(?)", ((p,) for p in self.rows))
        self.writer.commit()

    def command(self, *args, error=None):
        proc = subprocess.run([sys.executable, str(Path(__file__).with_name("recovery.py")),
                               *map(str, args), "--shift-vault", str(self.checkout)],
                              capture_output=True, text=True, timeout=30)
        if error is not None:
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn(error, proc.stderr)
            return
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def verify_version(self, record, destination, rows):
        receipt = self.command("vault-restore", self.repo, destination, "--sha256", record["sha256"])
        self.assertEqual(receipt["sha256"], hashlib.sha256(destination.read_bytes()).hexdigest())
        self.assertEqual(receipt["bytes"], record["bytes"])
        with closing(sqlite3.connect(destination)) as restored:
            actual = restored.execute("SELECT id,payload FROM scans ORDER BY id").fetchall()
            self.assertEqual(actual, list(enumerate(rows, 1)))
            self.assertEqual(restored.execute("PRAGMA journal_mode").fetchone(), ("delete",))

    def test_versions_while_wal_writer_is_open_and_damaged_newest(self):
        extra = b"final received scan"
        self.writer.execute("INSERT INTO scans(payload) VALUES(?)", (extra,))
        self.assertGreater(Path(str(self.live) + "-wal").stat().st_size, 0)
        first = self.command("vault-snapshot", self.live, self.repo)
        self.writer.commit()
        self.writer.execute("INSERT INTO scans(payload) VALUES(?)", (b"uncommitted",))
        second = self.command("vault-snapshot", self.live, self.repo)
        self.writer.rollback()
        self.assertNotEqual(first["sha256"], second["sha256"])
        self.assertGreater(second["added_bytes"], 0)
        self.assertGreater(second["reused_bytes"], second["added_bytes"])
        self.assertEqual(second["added_bytes"] + second["reused_bytes"], second["bytes"])
        repeated = self.command("vault-snapshot", self.live, self.repo)
        self.assertEqual(repeated["sha256"], second["sha256"])
        self.assertEqual(repeated["added_bytes"], 0)
        self.verify_version(first, self.root / "early.db", self.rows)
        self.verify_version(second, self.root / "latest.db", [*self.rows, extra])
        print(f"Restored 2000 and 2001 scans. Second snapshot: {second['added_bytes']} added, "
              f"{second['reused_bytes']} reused, {second['bytes']} total bytes.", flush=True)

        with closing(sqlite3.connect(self.repo / "vault.sqlite3")) as store, store:
            key, = store.execute("""SELECT object FROM parts WHERE snapshot=?
                                 EXCEPT SELECT object FROM parts WHERE snapshot=? LIMIT 1""",
                                 (second["sha256"], first["sha256"])).fetchone()
            store.execute("UPDATE objects SET data=x'00' WHERE hash=?", (key,))
        failed = self.root / "damaged.db"
        self.command("vault-restore", self.repo, failed, "--sha256", second["sha256"], error="damaged chunk")
        self.assertFalse(failed.exists())
        self.verify_version(first, self.root / "fallback.db", self.rows)

    def test_vault_files_and_existing_database_are_preserved(self):
        record = self.command("vault-snapshot", self.live, self.repo)
        self.command("vault-snapshot", self.repo / "vault.sqlite3", self.repo, error="outside")
        self.command("vault-restore", self.repo, self.repo / "output.db",
                     "--sha256", record["sha256"], error="outside")
        target = self.root / "out.db"
        target.write_bytes(b"previous")
        self.command("vault-restore", self.repo, target, "--sha256", record["sha256"], error="out.db")
        self.assertEqual(target.read_bytes(), b"previous")
        sidecar = self.root / "other.db-wal"
        sidecar.write_bytes(b"previous log")
        self.command("vault-restore", self.repo, self.root / "other.db", "--sha256", record["sha256"],
                     error="sidecar")
        self.assertFalse((self.root / "other.db").exists())
        self.assertEqual(sidecar.read_bytes(), b"previous log")

    def test_matching_hash_with_foreign_key_violation_is_rejected(self):
        bad = self.root / "invalid.db"
        with closing(sqlite3.connect(bad)) as db:
            db.executescript("""PRAGMA foreign_keys=OFF;
                             CREATE TABLE parents (id INTEGER PRIMARY KEY);
                             CREATE TABLE children (parent INTEGER REFERENCES parents(id));
                             INSERT INTO children VALUES (99);""")
        self.command("vault-snapshot", bad, self.repo, error="Foreign key")
        self.assertFalse(self.repo.exists())
        generic = subprocess.run([sys.executable, str(self.checkout / "vault.py"), str(self.repo),
                                  "backup", str(bad)], check=True, capture_output=True, text=True)
        sha = json.loads(generic.stdout)["snapshot"]
        self.assertEqual(sha, hashlib.sha256(bad.read_bytes()).hexdigest())
        dest = self.root / "must-not-publish.db"
        self.command("vault-restore", self.repo, dest, "--sha256", sha, error="Foreign key")
        self.assertFalse(dest.exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path, nargs="?", default=VaultRecoveryTests.checkout)
    VaultRecoveryTests.checkout = parser.parse_args().checkout.resolve()
    unittest.main(argv=[sys.argv[0]], verbosity=2)
