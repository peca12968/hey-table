import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier

from agenda import EPOCH, calendar_bytes, propose, read_event, revise

EXAMPLES = Path(__file__).parent / "examples"


class AgendaTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.db = Path(folder.name) / "pickup.db"
        self.snap = json.loads((EXAMPLES / "stations.json").read_text())
        self.estimate = json.loads((EXAMPLES / "estimate.json").read_text())

    def propose(self, store="north", number=17):
        return propose(self.db, store, number, self.snap, self.estimate)

    def advance(self, ms, durations):
        self.snap["capturedAt"] += ms
        at = self.estimate["capturedAt"] = self.snap["capturedAt"]
        row = self.estimate["orders"][0]
        row["seconds"] = durations
        row["readyAt"] = [
            (EPOCH + timedelta(milliseconds=at + 1000 * d)).isoformat(
                timespec="milliseconds"
            )
            for d in durations
        ]

    def test_duplicate_and_stale_observations_do_not_rewind_manual_changes(self):
        initial = self.propose()
        saved_snapshot, saved_estimate = deepcopy(self.snap), deepcopy(self.estimate)
        self.assertEqual(self.propose(), initial)
        self.advance(1000, [479, 599])
        self.assertEqual(self.propose(), initial)
        self.advance(0, [480, 600])
        with self.assertRaisesRegex(ValueError, "conflicting"):
            self.propose()
        self.advance(1000, [480, 600])
        newer = self.propose()
        self.assertEqual((newer["uid"], newer["sequence"]), (initial["uid"], 1))
        with self.assertRaisesRegex(ValueError, "stale"):
            propose(self.db, "north", 17, saved_snapshot, saved_estimate)
        args = ("2026-11-23T12:18:00+08:00", "2026-11-23T12:23:00+08:00")
        confirmation = revise(self.db, newer["uid"], 1, "CONFIRMED", *args)
        self.advance(1000, [500, 600])
        self.assertEqual(self.propose(), confirmation)
        cancelled = revise(self.db, newer["uid"], 2, "CANCELLED")
        self.assertEqual(
            revise(self.db, newer["uid"], 1, "CONFIRMED", *args), confirmation
        )
        self.assertEqual(read_event(self.db, newer["uid"]), cancelled)
        self.assertEqual(self.propose(), cancelled)
        with self.assertRaisesRegex(ValueError, "cancelled"):
            revise(self.db, newer["uid"], 3, "CONFIRMED", *args)

    def test_one_of_eight_edits_wins(self):
        uid = self.propose()["uid"]
        gate = Barrier(8, timeout=10)

        def attempt(i):
            gate.wait()
            try:
                return revise(
                    self.db,
                    uid,
                    0,
                    "CONFIRMED",
                    f"2026-11-23T04:{10 + i}:00Z",
                    "2026-11-23T04:25:00Z",
                )
            except ValueError as error:
                self.assertIn("revision changed", str(error))
                return None

        with ThreadPoolExecutor(max_workers=8) as pool:
            wins = [e for e in pool.map(attempt, range(8)) if e is not None]
        self.assertEqual(wins, [read_event(self.db, uid)])
        self.assertEqual(wins[0]["sequence"], 1)

    def test_sources_scope_fractional_seconds_and_point_estimate(self):
        event = self.propose()
        self.assertNotEqual(self.propose(store="south")["uid"], event["uid"])
        with self.assertRaisesRegex(ValueError, "preparing pickup"):
            self.propose(number=18)
        self.estimate["capturedAt"] += 1
        with self.assertRaisesRegex(ValueError, "same capture"):
            self.propose()
        self.advance(1000, [0, 0])
        point = self.propose()
        self.assertNotIn(b"DTEND", calendar_bytes(point))
        self.advance(375, [0, 0])
        rounded = self.propose()
        self.assertEqual(rounded["end"] - rounded["start"], 1)
        self.estimate["orders"][0]["seconds"] = [1, 2]
        with self.assertRaisesRegex(ValueError, "disagree"):
            self.propose()

    def test_store_number_and_creation_together_identify_ticket(self):
        old = self.propose()
        self.snap["orders"][-1]["created"] += 1
        self.assertNotEqual(self.propose()["uid"], old["uid"])
        self.estimate["orders"].append(self.estimate["orders"][0])
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.propose()
