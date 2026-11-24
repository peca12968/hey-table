from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import copy
import itertools
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

from count_relay import delta, initialize, manifest, merge, record, report, snapshot
from demo import demonstrate


class CountTests(unittest.TestCase):
    def test_incremental_matches_full_with_concurrent_local_edit_and_reordered_replies(self):
        a, b, comparison = [self.station(n) for n in ("a", "b", "full")]
        record(a, "crate", 3, "a")
        for receiver in (b, comparison):
            merge(receiver, snapshot(a))
        base = manifest(b)
        record(b, "crate", 9, "b")
        merge(comparison, snapshot(b))
        record(a, "crate", 5, "a")
        older = delta(a, base)
        record(a, "crate", 7, "a")
        newer = delta(a, base)
        self.assertEqual([len(p["events"]) for p in (older, newer)], [1, 2])
        self.assertEqual(merge(b, newer)["imported"], 2)
        self.assertEqual(merge(b, older), {"imported": 0, "known": 1})
        merge(comparison, snapshot(a))
        self.assertEqual(snapshot(b), snapshot(comparison))
        self.assertEqual(report(b)["conflicted_batches"], 1)
        self.assertEqual(delta(a, manifest(b))["events"], {})

    def test_unknown_base_and_missing_parent_preserve_receiver(self):
        a, b, other = [self.station(n) for n in ("a", "b", "other")]
        entry = record(a, "crate", 3, "a")["id"]
        merge(b, snapshot(a))
        base = manifest(b)
        child = record(a, "crate", 4, "a")["id"]
        packet = delta(a, base)
        with self.assertRaisesRegex(ValueError, "unknown delta base"):
            merge(other, packet)
        before = snapshot(b)
        missing = copy.deepcopy(packet)
        missing["events"][child]["parents"] = ["f" * 32]
        with self.assertRaisesRegex(ValueError, "missing or unrelated"):
            merge(b, missing)
        self.assertEqual(snapshot(b), before)
        # Full snapshots still have to carry every ancestor, even if the receiver has it.
        incomplete = snapshot(a)
        del incomplete["events"][entry]
        with self.assertRaisesRegex(ValueError, "missing or unrelated"):
            merge(b, incomplete)
        self.assertEqual(snapshot(b), before)
        self.assertEqual(merge(b, packet)["imported"], 1)

    def test_manifest_hash_detects_shared_id_conflicts_and_wrong_session(self):
        path = self.station("a")
        old = record(path, "crate", 3, "a")["id"]
        basis = manifest(path)
        basis["known"][old] = "0" * 64
        with self.assertRaisesRegex(ValueError, "different content"):
            delta(path, basis)
        basis["session"] = "other"
        with self.assertRaisesRegex(ValueError, "another count session"):
            delta(path, basis)

    def test_incremental_cli_on_pre_manifest_database(self):
        a, b = self.station("a"), self.station("b")
        record(a, "crate", 1, "east")
        merge(b, snapshot(a))
        record(a, "crate", 0, "east")
        cli = [sys.executable, str(Path(__file__).with_name("count_relay.py"))]
        request, reply = self.root / "request.json", self.root / "reply.json"
        request.write_bytes(subprocess.check_output(cli + ["manifest", b]))
        reply.write_bytes(subprocess.check_output(cli + ["delta", a, request]))
        for n in (1, 0):
            self.assertEqual(json.loads(subprocess.check_output(cli + ["merge", b, reply]))["imported"], n)
        self.assertEqual(report(b), report(a))

    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def station(self, name):
        path = self.root / name
        initialize(path, "audit")
        return path

    def test_demo(self):
        self.assertEqual(demonstrate(self.root), {
            "confirmed_before_recount": 20, "disputed_readings": [4, 6],
            "confirmed_after_recount": 25, "observations_added_by_old_snapshot": 0})

    def test_convergence_across_all_delivery_orders_with_unseen_concurrent_work(self):
        east, west, late = [self.station(name) for name in ("east", "west", "late")]
        record(east, "crate", 3, "initial")
        common = snapshot(east)
        merge(west, common)
        merge(late, common)
        record(east, "crate", 4, "east")
        record(west, "crate", 6, "west")
        record(late, "crate", 7, "late")
        e, w, l = map(snapshot, (east, west, late))
        merge(east, w)
        record(east, "crate", 5, "recount", report(east)["batches"]["crate"]["revision"])
        resolved = snapshot(east)
        final_reports = []
        for i, delivery in enumerate(itertools.permutations([e, w, l, resolved])):
            replica = self.station(f"replica-{i}")
            for packet in delivery:
                merge(replica, packet)
                self.assertEqual(merge(replica, packet)["imported"], 0)
            view = report(replica)
            self.assertEqual(view["confirmed_units"], 0)
            self.assertEqual(view["conflicted_batches"], 1)
            self.assertEqual(sorted(r["units"] for r in view["batches"]["crate"]["readings"]), [5, 7])
            self.assertEqual(len(snapshot(replica)["events"]), 5)
            final_reports.append(view)
        self.assertTrue(all(view == final_reports[0] for view in final_reports))

    def test_equal_readings_and_zero_do_not_double_count(self):
        a, b = self.station("a"), self.station("b")
        record(a, "crate", 9, "a")
        record(b, "crate", 9, "b")
        merge(a, snapshot(b))
        self.assertEqual(report(a)["confirmed_units"], 9)
        correction = record(a, "crate", 0, "a")
        self.assertEqual(len(correction["parents"]), 2)
        self.assertEqual(report(a)["batches"]["crate"]["units"], 0)
        self.assertEqual(report(a)["conflicted_batches"], 0)

    def test_racing_reviewers_only_one_can_resolve_the_seen_revision(self):
        a, b = self.station("a"), self.station("b")
        record(a, "crate", 4, "a")
        record(b, "crate", 6, "b")
        merge(a, snapshot(b))
        with self.assertRaisesRegex(ValueError, "review conflicting"):
            record(a, "crate", 8, "r")
        version = report(a)["batches"]["crate"]["revision"]
        gate = Barrier(2)

        def reconcile(qty):
            gate.wait(timeout=5)
            try:
                record(a, "crate", qty, "review", version)
                return "ok"
            except ValueError as exc:
                return str(exc)

        with ThreadPoolExecutor(2) as pool:
            outcomes = list(pool.map(reconcile, [5, 7]))
        self.assertCountEqual(outcomes, ["ok", "batch changed since review"])
        self.assertEqual(len(snapshot(a)["events"]), 3)

    def test_bad_history_aborts_entire_import(self):
        a, b = self.station("a"), self.station("b")
        old = record(a, "crate", 3, "a")["id"]
        original = snapshot(a)
        merge(b, original)
        new = record(b, "crate", 4, "b")["id"]
        valid = snapshot(b)
        for defect in ("cycle", "unknown", "unrelated", "collision", "wrong-session", "negative"):
            with self.subTest(defect=defect):
                bad = copy.deepcopy(valid)
                if defect == "cycle":
                    bad["events"][old]["parents"] = [new]
                elif defect == "unknown":
                    bad["events"][new]["parents"] = ["f" * 32]
                elif defect == "unrelated":
                    bad["events"][new]["batch"] = "another"
                elif defect == "collision":
                    bad["events"][old]["units"] = 88
                elif defect == "wrong-session":
                    bad["session"] = "other"
                else:
                    bad["events"][new]["units"] = -1
                with self.assertRaises(ValueError):
                    merge(a, bad)
                self.assertEqual(snapshot(a), original)
        record(b, "other", 12, "b")
        with closing(sqlite3.connect(a)) as db:
            db.execute("""CREATE TRIGGER fail_second BEFORE INSERT ON observations
                          WHEN (SELECT COUNT(*) FROM observations) = 2
                          BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            merge(a, snapshot(b))
        self.assertEqual(snapshot(a), original)

    def test_cli_snapshot_roundtrip(self):
        cli = [sys.executable, str(Path(__file__).with_name("count_relay.py"))]
        a, b = self.root / "a", self.root / "b"
        for path in (a, b):
            subprocess.run(cli + ["init", path, "audit"], capture_output=True, check=True)
        subprocess.run(cli + ["record", a, "rack-1", "42", "--device", "east"], capture_output=True, check=True)
        packet = self.root / "transfer.json"
        packet.write_bytes(subprocess.check_output(cli + ["export", a]))
        for expected in (1, 0):
            self.assertEqual(json.loads(subprocess.check_output(cli + ["merge", b, packet]))["imported"], expected)
        self.assertEqual(json.loads(subprocess.check_output(cli + ["status", b]))["confirmed_units"], 42)
        packet.write_text('{"format":1,"format":2}')
        failed = subprocess.run(cli + ["merge", b, packet], capture_output=True)
        self.assertEqual(failed.returncode, 2)
        self.assertIn(b"duplicate JSON key", failed.stderr)
