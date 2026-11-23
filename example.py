"""Write four fictional station exports into a new directory."""

import argparse
import json
from pathlib import Path


def lunch():
    states = [
        ["preparing", "pending", "pending", "pending", "pending"],
        ["ready", "preparing", "preparing", "pending", "cancelled"],
        ["completed", "ready", "preparing", "pending", "cancelled"],
        ["completed", "ready", "preparing", "ready", "cancelled"],
    ]
    for index, statuses in enumerate(states):
        rows = [dict(id=key, created=90000, mode="pickup" if key % 2 else "table",
                     table=None if key % 2 else "A03", status=status, note="",
                     items=[dict(id="gyoza", name="煎餃", qty=1)])
                for key, status in enumerate(statuses, 1)]
        yield dict(format="hey-table.station-orders.v1", capturedAt=100000 + index * 30000,
                   throughId=5, orders=rows[::-1])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    target = parser.parse_args().directory
    target.mkdir()
    for number, snapshot in enumerate(lunch(), 1):
        (target / f"{number}.json").write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
