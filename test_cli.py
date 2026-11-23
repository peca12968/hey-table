from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import random
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


class ParcelWindowsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build = tempfile.TemporaryDirectory()
        cls.addClassCleanup(build.cleanup)
        subprocess.run(["javac", "--release", "21", "-Xlint:all", "-Werror", "-d", build.name,
                        str(ROOT / "src/ParcelWindows.java"), str(ROOT / "src/ParcelBatch.java")],
                       check=True, timeout=45)
        cls.cmd = ["java", "-cp", build.name, "ParcelWindows"]

    def run_cli(self, data="", *args):
        return subprocess.run([*self.cmd, *args], input=data, text=True,
                              capture_output=True, timeout=15)

    def batch(self, mode, number, parent, target, data=b""):
        return subprocess.run([*self.cmd[:-1], "ParcelBatch", mode, str(number), parent, target, "-"],
                              input=data, capture_output=True, timeout=15)

    def run_parts(self, parts):
        output = []
        with tempfile.TemporaryDirectory() as directory:
            parent = "-"
            for i, data in enumerate(parts, 1):
                target = Path(directory) / f"{i}.zip"
                result = self.batch("finish" if i == len(parts) else "append", i, parent, target, data)
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(target) as archive:
                    self.assertEqual(archive.namelist(), ["records.tsv", "state.bin"])
                    output.append(archive.read("records.tsv"))
                parent = target
        return b"".join(output)

    def test_restart_at_every_example_boundary(self):
        data = (ROOT / "examples/scans.tsv").read_bytes()
        lines = data.splitlines(keepends=True)
        expected = subprocess.run(self.cmd, input=data, capture_output=True, check=True, timeout=15).stdout
        for cut in range(len(lines) + 1):
            with self.subTest(cut=cut):
                self.assertEqual(self.run_parts([b"".join(lines[:cut]), b"".join(lines[cut:])]), expected)

    def test_failed_batch_can_retry_and_final_cannot_continue(self):
        with tempfile.TemporaryDirectory() as directory:
            parent, target, other = [Path(directory) / name for name in ("1.zip", "2.zip", "3.zip")]
            first = self.batch("append", 1, "-", parent, b"SCAN\t1970-01-01T00:00:00.000000001Z\ta\tH\n")
            self.assertEqual(first.returncode, 0, first.stderr)
            original = parent.read_bytes()
            data = b"WATERMARK\t1970-01-01T00:05:00Z\n"
            for number, previous, payload in [(2, parent, data + b"BAD\n"), (2, parent, b"\xff"),
                                               (3, parent, data), (2, "-", data)]:
                self.assertNotEqual(self.batch("finish", number, previous, target, payload).returncode, 0)
                self.assertFalse(target.exists())
                self.assertEqual(parent.read_bytes(), original)
            retry = self.batch("finish", 2, parent, target, data)
            self.assertEqual(retry.returncode, 0, retry.stderr)
            with zipfile.ZipFile(target) as archive:
                records = archive.read("records.tsv").splitlines()
                self.assertEqual(len(records), 2)
                self.assertTrue(records[1].startswith(b"SUMMARY\taccepted=1\t"))
            self.assertNotEqual(self.batch("append", 3, target, other).returncode, 0)
            self.assertFalse(other.exists())

    def test_checkpoint_damage_and_unknown_version(self):
        with tempfile.TemporaryDirectory() as directory:
            parent, damaged, target = [Path(directory) / name for name in ("1.zip", "bad.zip", "2.zip")]
            self.assertEqual(self.batch("append", 1, "-", parent).returncode, 0)
            with zipfile.ZipFile(parent) as archive:
                state = archive.read("state.bin")
            for bad_state in [state[:-1], b"XYZ!" + state[4:], state + b"extra"]:
                with zipfile.ZipFile(damaged, "w") as archive:
                    archive.writestr("records.tsv", b"")
                    archive.writestr("state.bin", bad_state)
                self.assertNotEqual(self.batch("finish", 2, damaged, target).returncode, 0)
                self.assertFalse(target.exists())
            with zipfile.ZipFile(damaged, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.writestr("records.tsv", b"uniquely-marked-output")
                archive.writestr("state.bin", state)
            damaged.write_bytes(damaged.read_bytes().replace(b"uniquely-marked-output", b"damaged!-marked-output"))
            self.assertNotEqual(self.batch("finish", 2, damaged, target).returncode, 0)
            self.assertFalse(target.exists())

    def test_competing_writers_publish_one_complete_batch(self):
        with tempfile.TemporaryDirectory() as directory, ThreadPoolExecutor(max_workers=2) as pool:
            target = Path(directory) / "1.zip"
            hubs = ["TPE", "KHH"]
            attempts = [pool.submit(self.batch, "finish", 1, "-", target,
                                    f"SCAN\t{iso(0)}\ta\t{hub}\n".encode()) for hub in hubs]
            results = [attempt.result() for attempt in attempts]
            self.assertEqual(sorted(r.returncode for r in results), [0, 1])
            winner = hubs[next(i for i, r in enumerate(results) if r.returncode == 0)]
            with zipfile.ZipFile(target) as archive:
                self.assertIsNone(archive.testzip())
                self.assertIn(f"\t{winner}\t1".encode(), archive.read("records.tsv"))

    def test_example_counts_and_rejections(self):
        result = self.run_cli("", ROOT / "examples/scans.tsv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "REJECT\tconflict\t2026-06-01T00:30:00Z\tA1\tKHH\t2026-06-01T00:03:30Z",
            "WINDOW\t2026-06-01T00:00:00Z\t2026-06-01T00:05:00Z\tKHH\t1",
            "WINDOW\t2026-06-01T00:00:00Z\t2026-06-01T00:05:00Z\tTPE\t2",
            "REJECT\tlate\t2026-06-01T00:04:59Z\tA3\tTPE\t2026-06-01T00:05:00Z",
            "WINDOW\t2026-06-01T00:05:00Z\t2026-06-01T00:10:00Z\tKHH\t2",
            "SUMMARY\taccepted=5\tduplicates=1\tlate=1\tconflicts=1",
        ])

    def test_finalized_result_is_readable_while_input_remains_open(self):
        proc = subprocess.Popen(self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        with proc, ThreadPoolExecutor(max_workers=1) as pool:
            try:
                proc.stdin.write("SCAN\t1970-01-01T00:00:00Z\ta\tTPE\n"
                                 "WATERMARK\t1970-01-01T00:05:00Z\n")
                proc.stdin.flush()
                first = pool.submit(proc.stdout.readline).result(timeout=10).strip()
                self.assertEqual(first, f"WINDOW\t{iso(0)}\t{iso(300)}\tTPE\t1")
                self.assertIsNone(proc.poll())
                remaining, errors = proc.communicate(timeout=10)
                self.assertEqual(proc.returncode, 0, errors)
                self.assertEqual(remaining.strip(), "SUMMARY\taccepted=1\tduplicates=0\tlate=0\tconflicts=0")
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=10)

    def test_epoch_floor_fractional_boundary_and_watermark_cannot_rewind(self):
        data = ("SCAN\t1969-12-31T23:59:59.999999999Z\tfirst\tH\n"
                "WATERMARK\t1970-01-01T00:00:00Z\n"
                "WATERMARK\t1969-12-31T23:00:00Z\n"
                "SCAN\t1969-12-31T23:59:59.999999999Z\tfirst\tH\n"
                "SCAN\t1970-01-01T00:00:00Z\tfirst\tH\n")
        result = self.run_cli(data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "WINDOW\t1969-12-31T23:55:00Z\t1970-01-01T00:00:00Z\tH\t1",
            "REJECT\tlate\t1969-12-31T23:59:59.999999999Z\tfirst\tH\t1970-01-01T00:00:00Z",
            f"WINDOW\t{iso(0)}\t{iso(300)}\tH\t1",
            "SUMMARY\taccepted=2\tduplicates=0\tlate=1\tconflicts=0",
        ])

    def test_seeded_stream_matches_independent_full_history_reference(self):
        rng = random.Random(917)
        inputs, accepted, expected_rejects = [], [], []
        watermark = -10**9
        duplicates = 0
        for i in range(1200):
            if i % 37 == 0:
                tick = i * 4 - rng.randrange(360)
                inputs.append(f"WATERMARK\t{iso(tick)}")
                watermark = max(watermark, tick)
                continue
            scan = (i * 4 + rng.randrange(-450, 450), f"S{rng.randrange(175)}",
                    rng.choice(["KHH", "TPE", "TXG"]))
            if accepted and i % 11 == 0:
                scan = rng.choice(accepted[-20:])
            at, key, hub = scan
            inputs.append(f"SCAN\t{iso(at)}\t{key}\t{hub}")
            # Keep the full input history. Compare active IDs by scanning previously
            # accepted rows, independently of the Java maps and eviction algorithm.
            if (at // 300 + 1) * 300 <= watermark:
                reason = "late"
            else:
                active = [s for s in accepted if s[1] == key and (s[0] // 300 + 1) * 300 > watermark]
                if not active:
                    accepted.append(scan)
                    watermark = max(watermark, at - 120)
                    continue
                if scan == active[0]:
                    duplicates += 1
                    continue
                reason = "conflict"
            expected_rejects.append(["REJECT", reason, iso(at), key, hub, iso(watermark)])

        result = self.run_cli("\n".join(inputs) + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        parts = [("\n".join(inputs[i:i + 150]) + "\n").encode() for i in range(0, len(inputs), 150)]
        self.assertEqual(self.run_parts(parts).decode().splitlines(), result.stdout.splitlines())
        rows = [line.split("\t") for line in result.stdout.splitlines()]
        counts = Counter((s[0] // 300 * 300, s[2]) for s in accepted)
        self.assertEqual([r for r in rows if r[0] == "WINDOW"], [
            ["WINDOW", iso(start), iso(start + 300), hub, str(count)]
            for (start, hub), count in sorted(counts.items())
        ])
        self.assertEqual([r for r in rows if r[0] == "REJECT"], expected_rejects)
        rejected = Counter(r[1] for r in expected_rejects)
        self.assertEqual(rows[-1], ["SUMMARY", f"accepted={len(accepted)}", f"duplicates={duplicates}",
                                    f"late={rejected['late']}", f"conflicts={rejected['conflict']}"])

    def test_malformed_stream_reports_line_and_has_no_completion_summary(self):
        good = f"SCAN\t{iso(0)}\tS\tH\nWATERMARK\t{iso(300)}\n"
        for bad in ["SCAN\t2026-05-01T00:00:00\tS\tH", f"SCAN\t{iso(1)}\tS\t",
                    "WATERMARK\tnonsense", "INVALID"]:
            with self.subTest(bad=bad):
                result = self.run_cli(good + bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("line 3", result.stderr)
                self.assertEqual(result.stdout.strip(), f"WINDOW\t{iso(0)}\t{iso(300)}\tH\t1")

    def test_empty_stream_emits_only_summary(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "SUMMARY\taccepted=0\tduplicates=0\tlate=0\tconflicts=0")

    def test_slow_partition_can_contribute_until_global_closure(self):
        data = (ROOT / "examples/sources.tsv").read_text(encoding="utf-8")
        lines = data.encode().splitlines(keepends=True)
        result = self.run_cli(data)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [
            "WINDOW\t2026-11-23T00:00:00Z\t2026-11-23T00:05:00Z\tSOUTH\t1",
            "REJECT\tlate\t2026-11-23T00:03:30Z\ts2\tSOUTH\t2026-11-23T00:05:00Z",
            "WINDOW\t2026-11-23T00:10:00Z\t2026-11-23T00:15:00Z\tNORTH\t1",
            "SUMMARY\taccepted=2\tduplicates=0\tlate=1\tconflicts=0"]
        self.assertEqual(result.stdout.splitlines(), expected)
        crlf = subprocess.check_output(self.cmd, input=data.replace("\n", "\r\n").encode(), timeout=15)
        self.assertEqual(crlf.decode().splitlines(), expected)
        self.assertIn("accepted=1\tduplicates=0\tlate=1", self.run_cli(b"".join(lines[1:3]).decode()).stdout)
        # Restart after every record, including while one partition has never reported.
        self.assertEqual(self.run_parts(lines + [b""]).decode().splitlines(), expected)
        with tempfile.TemporaryDirectory() as directory:
            parent = "-"
            for number, line in enumerate(lines, 1):
                target = Path(directory) / f"{number}.zip"
                result = self.batch("append", number, parent, target, line)
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(target) as archive:
                    emitted = archive.read("records.tsv").decode().splitlines()
                self.assertEqual(emitted, {4: expected[0:1], 5: expected[1:2], 7: expected[2:3]}.get(number, []))
                parent = target

    def test_source_control_and_conflict_before_initial_progress(self):
        head = "SOURCES\tA\tB\n"
        first = f"SCAN\t{iso(720)}\tone\tA\n"
        data = head + first + first + f"SCAN\t{iso(900)}\tone\tA\nEND_SOURCE\tB\nEND_SOURCE\tB\n"
        result = self.run_cli(data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], f"REJECT\tconflict\t{iso(900)}\tone\tA\t-")
        self.assertIn("accepted=1\tduplicates=1\tlate=0\tconflicts=1", result.stdout)
        for bad in [head + "END_SOURCE\tC", head + "END_SOURCE\tA\n" + first,
                    head + f"WATERMARK\t{iso(500)}", head + f"WATERMARK\tC\t{iso(800)}",
                    head + "SOURCES\tC", first + head, "SOURCES\tA\tA", "SOURCES\tA\t"]:
            result = self.run_cli(bad)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertNotIn("SUMMARY", result.stdout)
