"""Keep the fewest recorded fixes under a time-interpolated per-axis error budget."""
import argparse
from fractions import Fraction
import json
from pathlib import Path


def simplify(fixes, tolerance, split_gap_ms=None):
    if type(tolerance) is not int or tolerance < 0 or not isinstance(fixes, list) or not fixes:
        raise ValueError("expected nonempty fixes and nonnegative integer tolerance in mm")
    if split_gap_ms is not None and (type(split_gap_ms) is not int or split_gap_ms < 1):
        raise ValueError("expected positive integer gap threshold in ms")
    points = []
    starts = [0]
    for i, row in enumerate(fixes):
        if not isinstance(row, dict) or any(type(row.get(k)) is not int for k in ("t_ms", "x_mm", "y_mm")):
            raise ValueError(f"fix {i}: expected integer time and projected coordinates")
        if type(row.get("keep", False)) is not bool or (i and row["t_ms"] <= points[-1][0]):
            raise ValueError(f"fix {i}: expected a boolean keep flag and strictly increasing time")
        if i and split_gap_ms is not None and row["t_ms"] - points[-1][0] > split_gap_ms:
            starts.append(i)
        points.append((row["t_ms"], row["x_mm"], row["y_mm"]))

    segments = []
    worst = Fraction(0)
    for start, end in zip(starts, starts[1:] + [len(points)]):
        local, deviation = shortest_path(points[start:end], fixes[start:end], tolerance)
        indices = [i + start for i in local]
        segments.append({"kept_indices": indices, "fixes": [fixes[i] for i in indices]})
        worst = max(worst, deviation)
    return {"input_count": len(points), "kept_count": sum(len(s["fixes"]) for s in segments),
            "segments": segments, "max_axis_error_mm": {"numerator": worst.numerator, "denominator": worst.denominator}}


def shortest_path(points, fixes, tolerance):
    # Each reachable fix is a possible segment start. An earlier intermediate
    # fix constrains the allowed x and y slopes of every later endpoint.
    n = len(points)
    cost, parent = [n + 1] * n, [None] * n
    cost[0] = 1
    for i, (t, x, y) in enumerate(points):
        lower, upper = [None, None], [None, None]
        for j in range(i + 1, n):
            dt = points[j][0] - t
            deltas = (points[j][1] - x, points[j][2] - y)
            possible = True
            for axis, delta in enumerate(deltas):
                lo, hi = lower[axis], upper[axis]
                if lo is not None and (delta * lo[1] < lo[0] * dt or delta * hi[1] > hi[0] * dt):
                    possible = False
                if lo is None or (delta - tolerance) * lo[1] > lo[0] * dt:
                    lower[axis] = (delta - tolerance, dt)
                if hi is None or (delta + tolerance) * hi[1] < hi[0] * dt:
                    upper[axis] = (delta + tolerance, dt)
            if possible and cost[i] + 1 < cost[j]:
                cost[j], parent[j] = cost[i] + 1, i
            if fixes[j].get("keep") or any(lo[0] * hi[1] > hi[0] * lo[1] for lo, hi in zip(lower, upper)):
                break

    kept = []
    cursor = n - 1
    while cursor is not None:
        kept.append(cursor)
        cursor = parent[cursor]
    kept.reverse()
    worst = Fraction(0)
    for i, j in zip(kept, kept[1:]):
        start, end = points[i], points[j]
        duration = end[0] - start[0]
        for k in range(i + 1, j):
            p = points[k]
            for axis in (1, 2):
                residual = (p[axis] - start[axis]) * duration - (end[axis] - start[axis]) * (p[0] - start[0])
                worst = max(worst, Fraction(abs(residual), duration))
    return kept, worst


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixes", type=Path)
    parser.add_argument("--tolerance-mm", type=int, required=True)
    parser.add_argument("--split-gap-ms", type=int, help="start a new track after gaps longer than this")
    args = parser.parse_args()
    try:
        result = simplify(json.loads(args.fixes.read_text(encoding="utf-8-sig")), args.tolerance_mm, args.split_gap_ms)
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
