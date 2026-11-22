"""Compare fixed blocks and content-defined chunks after a 21-byte insertion."""
from hashlib import sha256
import json
from pathlib import Path
from random import Random
from tempfile import TemporaryDirectory

from vault import backup, restore


def fixed_blocks(data):
    return (data[pos:pos + 4096] for pos in range(0, len(data), 4096))


def demonstrate(work):
    original = Random(298).randbytes(1024 * 1024)
    updated = b"shift handoff header\n" + original
    known = {sha256(part).digest() for part in fixed_blocks(original)}
    fixed_added = 0
    for part in fixed_blocks(updated):
        key = sha256(part).digest()
        if key not in known:
            known.add(key)
            fixed_added += len(part)
    repo = work / "repo"
    source = work / "export.bin"
    output = work / "recovered.bin"
    stored = []
    for data in (original, updated):
        source.write_bytes(data)
        stored.append(backup(repo, source))
    repeat = backup(repo, source)
    for version, expected in zip(stored, (original, updated)):
        restore(repo, version["snapshot"], output)
        if output.read_bytes() != expected:
            raise ValueError("restored data differs")
    return {"size_after": len(updated), "fixed_added": fixed_added,
            "content_added": stored[1]["added_bytes"], "content_reused": stored[1]["reused_bytes"],
            "repeat_added": repeat["added_bytes"], "verified_versions": len(stored)}


if __name__ == "__main__":
    with TemporaryDirectory() as directory:
        print(json.dumps(demonstrate(Path(directory)), indent=2))
