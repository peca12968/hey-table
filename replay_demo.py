"""Check each WAL prefix against the rows SQLite actually recovers in a fresh copy."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import tempfile


def change_checksum_order(wal, stride):
    data = bytearray(wal)
    data[3] ^= 1
    words = struct.Struct(">II" if data[3] & 1 else "<II")
    a = b = 0

    def accumulate(block):
        nonlocal a, b
        for x, y in words.iter_unpack(block):
            a = (a + b + x) & 0xffffffff
            b = (b + a + y) & 0xffffffff
        return struct.pack(">II", a, b)

    data[24:32] = accumulate(data[:24])
    for offset in range(32, len(data), stride):
        accumulate(data[offset:offset + 8])
        data[offset+16:offset+24] = accumulate(data[offset+24:offset+stride])
    return data


def compare_prefixes(executable):
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source = root / "writer.db"
        with closing(sqlite3.connect(source)) as writer:
            writer.execute("pragma page_size=1024")
            writer.execute("pragma journal_mode=wal")
            writer.execute("pragma wal_autocheckpoint=0")
            writer.execute("create table receipt(id integer primary key, payload blob)")
            writer.execute("pragma wal_checkpoint(truncate)")
            base = source.read_bytes()
            for size in (80, 2500, 5000):
                writer.execute("insert into receipt(payload) values(zeroblob(?))", (size,))
                writer.commit()
            wal = (root / "writer.db-wal").read_bytes()
            assert writer.execute("pragma wal_checkpoint(restart)").fetchone()[0] == 0
            recycled_base = source.read_bytes()
            writer.execute("update receipt set payload=zeroblob(70) where id=1")
            writer.commit()
            recycled = (root / "writer.db-wal").read_bytes()
        stride = 24 + int.from_bytes(wal[8:12], "big")
        assert (len(wal) - 32) % stride == 0
        frames = (len(wal) - 32) // stride
        cases = [(f"frame-{i}", wal[:32 + stride*i]) for i in range(frames + 1)]
        cases.extend((f"partial-{i}", wal[:31 + stride*i]) for i in range(1, frames + 1))
        broken = bytearray(wal)
        broken[-1] ^= 1
        cases.append(("damaged-last-page", broken))
        damaged_salt = bytearray(wal)
        damaged_salt[len(wal)-stride+8] ^= 1
        cases.append(("other-generation", damaged_salt))
        cases.append(("opposite-checksum-order", change_checksum_order(wal, stride)))
        cases.append(("reused-wal", recycled))
        maximum_pending = 0
        for name, prefix in cases:
            directory = root / name
            directory.mkdir()
            db = directory / "copy.db"
            db.write_bytes(recycled_base if name == "reused-wal" else base)
            capture = directory / "copy.db-wal"
            capture.write_bytes(prefix)
            report = json.loads(subprocess.check_output([executable, capture]))
            assert capture.read_bytes() == prefix
            with closing(sqlite3.connect(db)) as reader:
                sizes = [row[0] for row in reader.execute("select length(payload) from receipt order by id")]
                pages = reader.execute("pragma page_count").fetchone()[0]
            if name == "reused-wal":
                assert report["stop"] == "salt_mismatch" and report["commits"] == 1
                assert sizes == [70, 2500, 5000]
            else:
                assert len(sizes) == report["commits"]
                assert sizes == [80, 2500, 5000][:len(sizes)], (name, sizes, report)
            if report["commits"]:
                assert pages == report["database_pages_at_last_commit"]
                assert report["last_commit_end_offset"] == 32 + stride * report["last_commit_frame"]
            else:
                assert report["last_commit_end_offset"] == 0
            maximum_pending = max(maximum_pending, report["valid_frames_after_last_commit"])
            if name == f"frame-{frames}":
                assert report["commits"] == 3 and report["last_commit_frame"] == frames
            if name.startswith("partial"):
                assert report["stop"] == "partial_frame"
            if name == "damaged-last-page":
                assert report["stop"] == "checksum_mismatch" and len(sizes) == 2
            if name == "other-generation":
                assert report["stop"] == "salt_mismatch" and len(sizes) == 2
            if name == "opposite-checksum-order":
                assert report["stop"] == "end" and len(sizes) == 3
        assert maximum_pending > 0
        return {"frames": frames, "commits": 3, "compared_copies": len(cases),
                "most_valid_frames_after_commit": maximum_pending}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    print(json.dumps(compare_prefixes(parser.parse_args().executable.resolve()), indent=2))
