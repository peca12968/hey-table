from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import random
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


class ParcelWindowsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build = tempfile.TemporaryDirectory()
        cls.addClassCleanup(build.cleanup)
        subprocess.run(["javac", "--release", "21", "-Xlint:all", "-Werror", "-d", build.name,
                        str(ROOT / "src/ParcelWindows.java")], check=True, timeout=45)
        cls.cmd = ["java", "-cp", build.name, "ParcelWindows"]

    def run_cli(self, data="", *args):
        return subprocess.run([*self.cmd, *args], input=data, text=True,
                              capture_output=True, timeout=15)

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
