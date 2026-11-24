"""Resume an actual PWC1 archive produced by the historical Java implementation."""
import argparse
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZipFile


def exercise(legacy):
    root = Path(__file__).resolve().parent
    data = (root / "examples/scans.tsv").read_bytes().splitlines(keepends=True)
    with TemporaryDirectory() as temp:
        work = Path(temp)
        builds = []
        for i, source in enumerate((legacy, root)):
            build = work / str(i)
            build.mkdir()
            subprocess.run(["javac", "--release", "21", "-d", build, source / "src/ParcelWindows.java",
                            source / "src/ParcelBatch.java"], check=True)
            builds.append(["java", "-cp", build])
        old, new = work / "old.zip", work / "new.zip"
        subprocess.run([*builds[0], "ParcelBatch", "append", "1", "-", old, "-"], input=b"".join(data[:4]), check=True)
        subprocess.run([*builds[1], "ParcelBatch", "finish", "2", old, new, "-"], input=b"".join(data[4:]), check=True)
        with ZipFile(old) as before, ZipFile(new) as after:
            assert before.read("state.bin")[:4] == after.read("state.bin")[:4] == b"PWC1"
            output = before.read("records.tsv") + after.read("records.tsv")
        baseline = subprocess.check_output([*builds[0], "ParcelWindows"], input=b"".join(data))
        assert output == baseline
        return output.decode().splitlines()[-1]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legacy_checkout", type=Path)
    print(exercise(parser.parse_args().legacy_checkout.resolve()))
