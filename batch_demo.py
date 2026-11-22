"""Run three JVMs, then compare their published output to a single streaming JVM."""
from pathlib import Path
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent


def main():
    source = ROOT / "examples/scans.tsv"
    rows = source.read_bytes().splitlines(keepends=True)
    with tempfile.TemporaryDirectory() as directory:
        work = Path(directory)
        subprocess.run(["javac", "--release", "21", "-d", work, ROOT / "src/ParcelWindows.java",
                        ROOT / "src/ParcelBatch.java"], check=True)
        java = ["java", "-cp", work]
        reference = subprocess.check_output([*java, "ParcelWindows", source])
        parts = [rows[:3], rows[3:7], rows[7:]]
        segments = []
        parent = "-"
        for i, part in enumerate(parts, 1):
            mode = "finish" if i == len(parts) else "append"
            output = work / f"{i}.zip"
            batch_input = work / f"{i}.tsv"
            batch_input.write_bytes(b"".join(part))
            subprocess.run([*java, "ParcelBatch", mode, str(i), parent, output, batch_input], check=True)
            with zipfile.ZipFile(output) as archive:
                segment = archive.read("records.tsv")
            print(f"Batch {i} ({mode}): {len(part)} inputs, {len(segment.splitlines())} output rows")
            segments.append(segment)
            parent = output
        if b"".join(segments) != reference:
            raise RuntimeError("Resumed output differs from the single-process run")
        print(reference.decode("utf-8").splitlines()[-1])


if __name__ == "__main__":
    main()
