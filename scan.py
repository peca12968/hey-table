"""Audit table QR images against an independent seating manifest, entirely offline."""
import argparse
from collections import Counter
from contextlib import nullcontext
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

import cv2
import numpy as np
import zxingcpp


@dataclass(frozen=True)
class Profile:
    name: str
    width_px: int
    tilt: float
    blur_sigma: float
    required: bool


def unique_texts(rows, key):
    if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) for row in rows):
        raise ValueError(f"Expected a nonempty list for {key}")
    values = [row.get(key) for row in rows]
    if any(not isinstance(s, str) or not s.strip() for s in values) or len(set(values)) != len(values):
        raise ValueError(f"Empty or repeated {key}")


def load_manifest(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    cards, settings = data["cards"], data["profiles"]
    unique_texts(cards, "table")
    unique_texts(cards, "expected")
    unique_texts(settings, "name")
    profiles = []
    for raw in settings:
        p = Profile(**raw)
        if type(p.width_px) is not int or not 16 <= p.width_px <= 2048 or type(p.required) is not bool:
            raise ValueError("width_px must be 16..2048 and required must be boolean")
        for value, high in [(p.tilt, 0.4), (p.blur_sigma, 8)]:
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= high:
                raise ValueError("tilt must be 0..0.4 and blur_sigma must be 0..8")
        profiles.append(p)
    if not any(p.required for p in profiles):
        raise ValueError("Mark at least one profile as required")
    return cards, profiles


def load_image(path):
    encoded = np.frombuffer(path.read_bytes(), dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED) if encoded.size else None
    if image is None or image.dtype != np.uint8:
        raise ValueError(f"Expected an 8-bit image: {path}")
    if image.ndim == 2:
        return image
    if image.shape[2] == 4:
        alpha = image[:, :, 3].astype(np.float32) / 255
        gray = cv2.cvtColor(image[:, :, :3], cv2.COLOR_BGR2GRAY)
        return np.rint(gray * alpha + 255 * (1-alpha)).astype(np.uint8)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def photograph(source, profile):
    height, width = source.shape
    w = profile.width_px
    h = max(2, round(w * height / width))
    if h > 4096:
        raise ValueError("Crop the QR region before projecting this aspect ratio")
    small = cv2.resize(source, (w, h), interpolation=cv2.INTER_AREA if w < width else cv2.INTER_LINEAR)
    pad = max(4, round(w * 0.07))
    t = profile.tilt
    if t:
        x, y = w-1, h-1
        corners = np.float32([[0, 0], [x, 0], [x, y], [0, y]])
        projected = np.float32([[0, t*y], [(1-t)*x, 0], [x, (1-t/2)*y], [t*x, y]]) + pad
        matrix = cv2.getPerspectiveTransform(corners, projected)
        scene = cv2.warpPerspective(small, matrix, (w+pad*2, h+pad*2), borderValue=205)
    else:
        scene = cv2.copyMakeBorder(small, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=205)
    if profile.blur_sigma:
        scene = cv2.GaussianBlur(scene, (0, 0), profile.blur_sigma)
    return scene


def decode(scene, expected):
    reads = zxingcpp.read_barcodes(scene, formats=zxingcpp.BarcodeFormat.QRCode)
    return compare_codes([r.bytes for r in reads if r.valid], expected)


def display_code(code):
    try:
        return code.decode("utf8")
    except UnicodeDecodeError:
        return {"hex": code.hex()}


def compare_codes(codes, expected):
    if not codes:
        status = "unreadable"
    elif len(codes) > 1:
        status = "ambiguous"
    else:
        status = "matched" if codes[0] == expected.encode("utf-8") else "wrong_target"
    return status, [display_code(code) for code in sorted(codes)]


def audit(path, failure_dir=None):
    cards, profiles = load_manifest(path)
    if failure_dir is not None and failure_dir.exists():
        raise ValueError(f"Choose a new failure directory: {failure_dir}")
    counts = Counter()
    checks = []
    passed = True
    # Stage diagnostic images so an invalid later input cannot publish a partial report.
    with (TemporaryDirectory(dir=failure_dir.parent) if failure_dir else nullcontext()) as tmp:
        if failure_dir is not None:
            staged = Path(tmp) / "results"
            staged.mkdir()
        for index, card in enumerate(cards, 1):
            source = load_image(path.parent / card["image"])
            for number, profile in enumerate(profiles, 1):
                scene = photograph(source, profile)
                status, observed = decode(scene, card["expected"])
                blocking = status in ("wrong_target", "ambiguous") or (profile.required and status == "unreadable")
                passed = passed and not blocking
                row = {"table": card["table"], "profile": profile.name, "expected": card["expected"],
                       "observed": observed, "status": status, "blocking": blocking}
                if status != "matched" and failure_dir is not None:
                    name = f"card-{index:03d}-profile-{number:02d}.png"
                    ok, png = cv2.imencode(".png", scene)
                    if not ok:
                        raise ValueError("Cannot encode diagnostic image")
                    (staged / name).write_bytes(png.tobytes())
                    row["image"] = name
                counts[status] += 1
                checks.append(row)
        report = {"passed": passed, "counts": dict(counts), "profiles": [asdict(p) for p in profiles], "checks": checks}
        if failure_dir is not None:
            (staged / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf8")
            staged.rename(failure_dir)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--failures", type=Path, help="new directory for nonmatching transformed images")
    args = parser.parse_args(argv)
    try:
        result = audit(args.manifest, args.failures)
    except (ValueError, TypeError, KeyError, OverflowError, OSError, cv2.error) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
