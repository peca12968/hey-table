from contextlib import closing, redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import cv2
import pypdfium2 as pdfium
import pypdfium2.raw as raw

from scan_sheet import audit_sheet, main, read_page


BUNDLE = Path(os.environ.get("TABLE_QR_MANIFEST", Path(__file__).parent/"examples"/"manifest.json")).resolve().parent
SOURCE = BUNDLE / "tables.pdf"
LAYOUT = BUNDLE / "sheet-layout.json"


class PrintedSheetChecks(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.modified = Path(directory.name) / "reprint.pdf"

    def test_printed_document(self):
        report = audit_sheet(SOURCE, LAYOUT)
        self.assertTrue(report["passed"])
        self.assertEqual(report["actual_pages"], 2)
        self.assertEqual([(c["page"], c["table"]) for c in report["checks"]],
                         [(1 + i // 4, f"A{i+1:02}") for i in range(8)])

    def reprint(self, pages, blank=False):
        with closing(pdfium.PdfDocument(SOURCE)) as source, closing(pdfium.PdfDocument.new()) as doc:
            doc.import_pages(source, pages=pages)
            if blank:
                doc.new_page(595, 842).close()
            doc.save(self.modified)
        return audit_sheet(self.modified, LAYOUT)

    def test_last_sheet_missing_and_extra_blank_sheet(self):
        missing = self.reprint([0])
        self.assertFalse(missing["passed"])
        self.assertEqual([c["table"] for c in missing["checks"] if c["status"] == "missing_page"],
                         ["A05", "A06", "A07", "A08"])
        extra = self.reprint([0, 1], blank=True)
        self.assertFalse(extra["passed"])
        self.assertEqual(extra["actual_pages"], 3)

    def test_pages_exchanged(self):
        report = self.reprint([1, 0])
        self.assertFalse(report["passed"])
        self.assertTrue(all(c["status"] == "wrong_target" for c in report["checks"]))

    def test_exchanged_qr_pixels_preserve_table_labels(self):
        with closing(pdfium.PdfDocument(SOURCE)) as source, closing(pdfium.PdfDocument.new()) as doc:
            with closing(source[0]) as original:
                width, height = original.get_size()
                with closing(original.render(scale=2, grayscale=True)) as bitmap:
                    pixels = bitmap.to_numpy()[:, :, 0].copy()
                locations = dict(read_page(original))
            rows, cols = pixels.shape
            regions = []
            for table in ["A01", "A02"]:
                target = next(bounds for url, bounds in locations.items() if url.endswith(table.encode()))
                l, t, r, b = [round(n*v) for n, v in zip([cols, rows, cols, rows], target)]
                regions.append((slice(t-4, b+5), slice(l-4, r+5)))
            crops = [pixels[area].copy() for area in regions]
            for area, other in zip(regions, reversed(crops)):
                h, w = pixels[area].shape
                pixels[area] = cv2.resize(other, (w, h), interpolation=cv2.INTER_NEAREST)
            with closing(doc.new_page(width, height)) as page:
                with closing(pdfium.PdfBitmap.new_native(cols, rows, raw.FPDFBitmap_Gray)) as bitmap:
                    bitmap.to_numpy()[:, :, 0] = pixels
                    image = pdfium.PdfImage.new(doc)
                    image.set_bitmap(bitmap)
                    image.set_matrix(pdfium.PdfMatrix(a=width, d=height))
                    page.insert_obj(image)
                    page.gen_content()
            doc.import_pages(source, pages=[1])
            doc.save(self.modified)
        report = audit_sheet(self.modified, LAYOUT)
        self.assertFalse(report["passed"])
        wrong = [(c["table"], c["observed"][0][-3:]) for c in report["checks"] if c["status"] != "matched"]
        self.assertEqual(wrong, [("A01", "A02"), ("A02", "A01")])

    def test_outside_slot_and_invalid_layout(self):
        layout = json.loads(LAYOUT.read_text(encoding="utf8"))
        layout["manifest"] = str(BUNDLE / "manifest.json")
        first, second = layout["pages"][0][:2]
        first["bounds"][2] = 0.25
        path = self.modified.with_suffix(".json")
        path.write_text(json.dumps(layout), encoding="utf8")
        with redirect_stdout(StringIO()) as stdout:
            self.assertEqual(main([str(SOURCE), str(path)]), 1)
        report = json.loads(stdout.getvalue())
        self.assertEqual(report["checks"][0]["status"], "unreadable")
        self.assertEqual([(u["page"], u["observed"][-3:]) for u in report["unexpected"]], [(1, "A01")])
        first["bounds"] = second["bounds"]
        path.write_text(json.dumps(layout), encoding="utf8")
        with redirect_stderr(StringIO()) as err:
            self.assertEqual(main([str(SOURCE), str(path)]), 2)
        self.assertIn("Overlapping", err.getvalue())


if __name__ == "__main__":
    unittest.main()
