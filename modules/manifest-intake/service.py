"""Commit a complete client-streamed manifest and its receipt in one SQLite transaction."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
from pathlib import Path
import re
import sqlite3
import struct

import grpc
import manifest_pb2 as pb
import manifest_pb2_grpc as rpc

IDENTIFIER = re.compile(r"[a-zA-Z0-9_.-]{1,96}")


def receipt(row, uniform, replayed=False):
    return pb.Receipt(manifest_id=row[0], boxes=row[1], units=row[2], sha256=row[3],
                      replayed=replayed, uniform_box_units=uniform)


class Intake(rpc.ManifestIntakeServicer):
    def __init__(self, database):
        self.database = database
        with closing(self.connect()) as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS manifests(
                    id TEXT PRIMARY KEY, boxes INTEGER NOT NULL, units INTEGER NOT NULL, sha256 TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS boxes(
                    manifest_id TEXT NOT NULL REFERENCES manifests(id), box_id TEXT NOT NULL, units INTEGER NOT NULL,
                    PRIMARY KEY(manifest_id, box_id)) WITHOUT ROWID;
            """)

    def connect(self):
        db = sqlite3.connect(self.database, isolation_level=None, timeout=5)
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def Lookup(self, key, context):
        with closing(self.connect()) as db:
            row = db.execute("SELECT id,boxes,units,sha256 FROM manifests WHERE id=?", (key.manifest_id,)).fetchone()
            if row is None:
                context.abort(grpc.StatusCode.NOT_FOUND, "manifest not published")
            uniform, = db.execute("SELECT MIN(units) = MAX(units) FROM boxes WHERE manifest_id=?",
                                  (key.manifest_id,)).fetchone()
            return receipt(row, None if uniform is None else bool(uniform))

    def Upload(self, parts, context):
        first = next(parts, None)
        if (first is None or first.WhichOneof("value") != "header" or
                not IDENTIFIER.fullmatch(first.header.manifest_id) or not first.header.expected_boxes):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "expected manifest header with ID and positive box count")
        key, expected = first.header.manifest_id, first.header.expected_boxes
        with closing(self.connect()) as db:
            db.execute("PRAGMA temp_store=FILE")
            db.execute("CREATE TEMP TABLE staged(box_id TEXT PRIMARY KEY, units INTEGER) WITHOUT ROWID")
            # Only the connection-private temporary database is written while receiving the stream.
            db.execute("BEGIN")
            count = units = 0
            first_units = None
            uniform = True
            for part in parts:
                box = part.box
                if part.WhichOneof("value") != "box" or not IDENTIFIER.fullmatch(box.box_id) or not box.units:
                    context.abort(grpc.StatusCode.INVALID_ARGUMENT, "expected a box with ID and positive units")
                count += 1
                if first_units is None:
                    first_units = box.units
                uniform = uniform and first_units == box.units
                units += box.units
                if count > expected or units > 2**63-1:
                    context.abort(grpc.StatusCode.OUT_OF_RANGE, "manifest totals exceed declared or supported range")
                try:
                    db.execute("INSERT INTO staged VALUES (?,?)", (box.box_id, box.units))
                except sqlite3.IntegrityError:
                    context.abort(grpc.StatusCode.INVALID_ARGUMENT, "duplicate box ID")
            if count != expected:
                context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"received {count} of {expected} boxes")
            db.commit()
            digest = hashlib.sha256()
            for box_id, amount in db.execute("SELECT box_id,units FROM staged ORDER BY box_id"):
                encoded = box_id.encode("ascii")
                digest.update(struct.pack(">H", len(encoded)) + encoded + struct.pack(">I", amount))
            sha = digest.hexdigest()
            if not context.is_active():
                context.abort(grpc.StatusCode.CANCELLED, "caller left before publication")
            try:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT id,boxes,units,sha256 FROM manifests WHERE id=?", (key,)).fetchone()
                if existing is not None:
                    if existing[3] != sha:
                        context.abort(grpc.StatusCode.ALREADY_EXISTS, "manifest ID belongs to different boxes")
                    return receipt(existing, uniform, replayed=True)
                row = (key, count, units, sha)
                db.execute("INSERT INTO manifests VALUES (?,?,?,?)", row)
                db.execute("INSERT INTO boxes SELECT ?,box_id,units FROM staged", (key,))
                db.commit()
                return receipt(row, uniform)
            except sqlite3.OperationalError as error:
                if (getattr(error, "sqlite_errorcode", 0) & 255) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                    context.abort(grpc.StatusCode.UNAVAILABLE, "database busy; retry the same manifest")
                raise


def make_server(database, address="127.0.0.1:0"):
    server = grpc.server(ThreadPoolExecutor(max_workers=12))
    rpc.add_ManifestIntakeServicer_to_server(Intake(database), server)
    port = server.add_insecure_port(address)
    return server, port


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--port", type=int, default=50051)
    args = parser.parse_args()
    server, port = make_server(args.database, f"127.0.0.1:{args.port}")
    server.start()
    print(f"Manifest Intake listening on 127.0.0.1:{port}", flush=True)
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        server.stop(3).wait()
