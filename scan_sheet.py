"""Check QR destinations at their assigned physical locations on every printed PDF page."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sys

import pypdfium2 as pdfium
import zxingcpp

from scan import compare_codes, display_code, unique_texts


def read_layout(path):
    layout = json.loads(path.read_text(encoding="utf-8-sig"))
    manifest = path.parent / layout["manifest"]
    cards = json.loads(manifest.read_text(encoding="utf-8-sig"))["cards"]
    unique_texts(cards, "table")
    unique_texts(cards, "expected")
    expected = {card["table"]: card["expected"] for card in cards}
    pages = layout["pages"]
    if not isinstance(pages, list) or not pages or not all(isinstance(p, list) for p in pages):
        raise ValueError("pages must be an ordered list of slot lists")
    slots = [slot for page in pages for slot in page]
    unique_texts(slots, "table")
    if {slot["table"] for slot in slots} != set(expected):
        raise ValueError("Assign each table from the seating manifest exactly once")
    for page in pages:
        earlier = []
        for slot in page:
            left, top, right, bottom = slot["bounds"]
            if not all(type(v) in (int, float) for v in (left, top, right, bottom)) or not (
                    0 <= left < right <= 1 and 0 <= top < bottom <= 1):
                raise ValueError("bounds must be normalized left, top, right, bottom")
            for x1, y1, x2, y2 in earlier:
                if left < x2 and x1 < right and top < y2 and y1 < bottom:
                    raise ValueError(f"Overlapping slot at table {slot['table']}")
            earlier.append(slot["bounds"])
    return pages, expected


def read_page(page):
    with closing(page.render(scale=2, grayscale=True)) as bitmap:
        scene = bitmap.to_numpy()[:, :, 0]
        height, width = scene.shape
        symbols = zxingcpp.read_barcodes(scene, formats=zxingcpp.BarcodeFormat.QRCode)
    detections = []
    for symbol in symbols:
        if symbol.valid:
            pos = symbol.position
            corners = (pos.top_left, pos.top_right, pos.bottom_left, pos.bottom_right)
            xs = [p.x / width for p in corners]
            ys = [p.y / height for p in corners]
            detections.append((symbol.bytes, [min(xs), min(ys), max(xs), max(ys)]))
    return detections


def audit_sheet(source, layout):
    pages, expected = read_layout(layout)
    checks, unexpected = [], []
    with closing(pdfium.PdfDocument(source)) as doc:
        count = len(doc)
        for index in range(max(count, len(pages))):
            page_number = index + 1
            slots = pages[index] if index < len(pages) else []
            by_table = {slot["table"]: [] for slot in slots}
            if index < count:
                with closing(doc[index]) as page:
                    for code, bounds in read_page(page):
                        x1, y1, x2, y2 = bounds
                        for slot in slots:
                            left, top, right, bottom = slot["bounds"]
                            if left <= x1 and top <= y1 and x2 <= right and y2 <= bottom:
                                by_table[slot["table"]].append(code)
                                break
                        else:
                            unexpected.append({"page": page_number, "observed": display_code(code),
                                               "bounds": [round(v, 4) for v in bounds]})
            for table, codes in by_table.items():
                status, observed = compare_codes(codes, expected[table])
                checks.append({"page": page_number, "table": table, "expected": expected[table],
                               "observed": observed, "status": status if index < count else "missing_page"})
    return {"passed": count == len(pages) and not unexpected and all(c["status"] == "matched" for c in checks),
            "expected_pages": len(pages), "actual_pages": count, "checks": checks, "unexpected": unexpected}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("layout", type=Path)
    args = parser.parse_args(argv)
    try:
        result = audit_sheet(args.pdf, args.layout)
    except (ValueError, TypeError, KeyError, OSError, pdfium.PdfiumError) as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
