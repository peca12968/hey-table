from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import cv2
import numpy as np
from scan import audit, decode, load_image, main

BUNDLE = Path(os.environ.get("TABLE_QR_MANIFEST", Path(__file__).parent/"examples"/"manifest.json")).resolve()


class CardChecks(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.manifest = json.loads(BUNDLE.read_text(encoding="utf8"))
        for card in self.manifest["cards"]:
            card["image"] = str(BUNDLE.parent/card["image"])
        self.path = self.root/"manifest.json"

    def save(self):
        self.path.write_text(json.dumps(self.manifest), encoding="utf8")

    def cli(self, *args):
        output, error = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(error):
            status = main([str(self.path), *map(str, args)])
        return status, output.getvalue(), error.getvalue()

    def test_all_tables_and_required_profiles(self):
        report = audit(BUNDLE)
        self.assertTrue(report["passed"])
        grouped = Counter((c["profile"], c["status"]) for c in report["checks"])
        self.assertEqual(grouped, {(p, "matched"):8 for p in ("straight","small","angled")} |
                         {("low-resolution","unreadable"):8})
        for check in report["checks"]:
            if check["status"] == "matched":
                self.assertEqual(check["observed"], [check["expected"]])

    def test_swapped_codes_keep_actual_destinations_and_exit_one(self):
        a, b = self.manifest["cards"][:2]
        a["image"], b["image"] = b["image"], a["image"]
        self.manifest["profiles"] = self.manifest["profiles"][:1]
        self.save()
        folder = self.root/"失敗樣本"
        code, out, err = self.cli("--failures", folder)
        self.assertEqual((code, err), (1, ""))
        result = json.loads(out)
        self.assertEqual(json.loads((folder/"report.json").read_text(encoding="utf8")), result)
        self.assertEqual(result["counts"], {"wrong_target":2, "matched":6})
        for check, actual in zip(result["checks"], (b["expected"], a["expected"])):
            self.assertTrue(check["blocking"])
            self.assertEqual(check["observed"], [actual])
            image = load_image(folder/check["image"])
            self.assertEqual(decode(image, check["expected"]), ("wrong_target", [actual]))
        self.assertEqual(len(list(folder.glob("*.png"))), 2)
        self.assertEqual(self.cli("--failures", folder)[:2], (2, ""))

    def test_multiple_codes_even_with_correct_destination_are_ambiguous(self):
        a, b = self.manifest["cards"][:2]
        left, right = load_image(Path(a["image"])), load_image(Path(b["image"]))
        double = np.concatenate([left, np.full((left.shape[0], 28), 255, np.uint8), right], axis=1)
        source = self.root/"double.png"
        source.write_bytes(cv2.imencode(".png", double)[1].tobytes())
        self.manifest["cards"] = [dict(a, image=source.name)]
        self.manifest["profiles"] = [dict(self.manifest["profiles"][0], width_px=640, required=False),
                                     dict(self.manifest["profiles"][0], name="mandatory", width_px=640)]
        self.save()
        result = audit(self.path)
        for check in result["checks"]:
            self.assertEqual(check["status"], "ambiguous")
            self.assertEqual(set(check["observed"]), {a["expected"], b["expected"]})
            self.assertTrue(check["blocking"])

    def test_unreadable_is_blocking_only_when_required(self):
        self.manifest["profiles"][-1]["required"] = True
        self.save()
        status, out, _ = self.cli()
        self.assertEqual(status, 1)
        result = json.loads(out)
        self.assertEqual(sum(r["blocking"] for r in result["checks"]), 8)

    def test_missing_image_does_not_publish_partial_diagnostics(self):
        self.manifest["cards"][-1]["image"] = "missing.png"
        self.save()
        folder = self.root/"diagnostics"
        self.assertEqual(self.cli("--failures", folder)[:2], (2, ""))
        self.assertFalse(folder.exists())

    def test_duplicate_destinations_and_invalid_projection_are_rejected(self):
        a, b = self.manifest["cards"][:2]
        b["expected"] = a["expected"]
        self.save()
        self.assertEqual(self.cli()[:2], (2, ""))
        self.manifest["cards"] = [a]
        self.manifest["profiles"][0]["tilt"] = 1
        self.save()
        self.assertEqual(self.cli()[:2], (2, ""))


if __name__ == "__main__":
    unittest.main()
