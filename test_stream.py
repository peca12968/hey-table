from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Event
import unittest
from unittest.mock import patch

import grpc
import manifest_pb2 as pb
import manifest_pb2_grpc as rpc
from client import stream
from service import Intake, make_server


class RealStreams(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name) / "receipts.db"
        self.stubs = []
        for _ in range(2):
            server, port = make_server(self.db)
            server.start()
            self.addCleanup(lambda s=server: s.stop(0).wait())
            channel = grpc.insecure_channel(f"127.0.0.1:{port}")
            self.addCleanup(channel.close)
            self.stubs.append(rpc.ManifestIntakeStub(channel))

    def assert_code(self, code, fn, *args):
        with self.assertRaises(grpc.RpcError) as caught:
            fn(*args, timeout=5)
        self.assertEqual(caught.exception.code(), code)

    def test_cancel_after_first_staged_box_and_publish_an_unrelated_manifest(self):
        staged, release = Event(), Event()
        connect = Intake.connect
        def observed(service):
            db = connect(service)
            db.set_trace_callback(lambda sql: staged.set() if sql.startswith("INSERT INTO staged") and "'slow-box'" in sql else None)
            return db
        def delayed():
            yield from stream("slow", 2, [("slow-box", 1)])
            release.wait(10)
            yield pb.Part(box=pb.Box(box_id="tail", units=2))
        with patch.object(Intake, "connect", observed):
            future = self.stubs[0].Upload.future(delayed(), timeout=10)
            try:
                self.assertTrue(staged.wait(5))
                self.assert_code(grpc.StatusCode.NOT_FOUND, self.stubs[1].Lookup, pb.ManifestKey(manifest_id="slow"))
                other = self.stubs[1].Upload(stream("other", 1, [("B", 7)]), timeout=3)
                self.assertEqual(other.units, 7)
                self.assertTrue(future.cancel())
            finally:
                release.set()
            self.assert_code(grpc.StatusCode.NOT_FOUND, self.stubs[1].Lookup, pb.ManifestKey(manifest_id="slow"))
        # A retry can use the same key with the originally intended complete contents.
        final = self.stubs[1].Upload(stream("slow", 2, [("slow-box", 1), ("tail", 2)]), timeout=5)
        self.assertFalse(final.replayed)
        self.assertEqual((final.boxes, final.units), (2, 3))

    def test_racing_reordered_retries_get_one_durable_receipt(self):
        rows = [(f"box-{i}", i+1) for i in range(128)]
        def upload(i):
            return self.stubs[i % 2].Upload(stream("shift", 128, rows if i % 2 else reversed(rows)), timeout=10)
        with ThreadPoolExecutor(max_workers=6) as pool:
            receipts = list(pool.map(upload, range(6)))
        self.assertEqual(sum(not r.replayed for r in receipts), 1)
        self.assertEqual(len({r.sha256 for r in receipts}), 1)
        received = self.stubs[1].Lookup(pb.ManifestKey(manifest_id="shift"), timeout=5)
        self.assertEqual((received.boxes, received.units, received.sha256), (128, 8256, receipts[0].sha256))
        altered = rows.copy()
        altered[0], altered[1] = ("box-0", 2), ("box-1", 1)
        self.assert_code(grpc.StatusCode.ALREADY_EXISTS, self.stubs[0].Upload, stream("shift", 128, altered))
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(dict(db.execute("SELECT box_id,units FROM boxes")), dict(rows))

    def test_clean_eof_duplicate_and_oversized_manifest_publish_nothing(self):
        for key, declared, rows, code in [
            ("short", 2, [("A", 1)], grpc.StatusCode.FAILED_PRECONDITION),
            ("duplicate", 2, [("A", 1), ("A", 1)], grpc.StatusCode.INVALID_ARGUMENT),
            ("extra", 1, [("A", 1), ("B", 1)], grpc.StatusCode.OUT_OF_RANGE),
        ]:
            self.assert_code(code, self.stubs[0].Upload, stream(key, declared, rows))
            self.assert_code(grpc.StatusCode.NOT_FOUND, self.stubs[1].Lookup, pb.ManifestKey(manifest_id=key))
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM boxes").fetchone(), (0,))
