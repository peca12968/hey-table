"""Use real Prep Sheet receipts to close a two-pot lunch shift."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parent


def run(upstream):
    sys.path.insert(0, str(upstream.resolve()))
    from ledger import FIELDS, connect, describe, initialize, post

    book = json.loads((upstream / "examples/recipes.json").read_bytes())
    book["dishes"]["plain-rice"] = [
        {"from_ms": 0, "uses": {"rice": 180}},
        {"from_ms": 1000, "uses": {"rice": 200}},
    ]
    with TemporaryDirectory() as directory:
        temp = Path(directory)
        db = temp / "lunch.db"
        initialize(db)
        for i in (1, 2):
            post(db, book, "receive", f"delivery-{i}", {"grain": 180, "water": 240})
            post(db, book, "make", f"pot-{i}", {"component": "rice", "batches": 1})
        for order, moment, portions in [(1, 999, 2), (2, 1000, 1)]:
            post(
                db,
                book,
                "issue",
                str(order),
                {
                    "id": order,
                    "created": moment,
                    "status": "preparing",
                    "items": [{"id": "plain-rice", "qty": portions}],
                },
            )
        with closing(connect(db, "ro")) as live:
            history = [
                describe(row)
                for row in live.execute(f"SELECT {FIELDS} FROM receipts ORDER BY id")
            ]
        documents = {
            "history": history,
            "invoices": {
                "1": {
                    "grain": {"unit": "g", "cost_cents": 1600},
                    "water": {"unit": "ml", "cost_cents": 200},
                },
                "3": {
                    "grain": {"unit": "g", "cost_cents": 2000},
                    "water": {"unit": "ml", "cost_cents": 200},
                },
            },
            "counts": {
                "through_receipt": 6,
                "components": {"rice": {"unit": "g", "quantity": 200, "discarded": 30}},
            },
        }
        files = []
        for name, doc in documents.items():
            path = temp / f"{name}.json"
            path.write_text(json.dumps(doc), encoding="utf8")
            files.append(path)
        result = json.loads(
            subprocess.check_output(
                [sys.executable, ROOT / "close.py", *files, "--after", "2"],
                encoding="utf8",
            )
        )
        fields = (
            "opening",
            "received",
            "issued",
            "discarded",
            "unexplained_short",
            "closing",
        )
        assert [result[f"{key}_cost_cents"] for key in fields] == [
            "1800",
            "2200",
            "2680",
            "165",
            "55",
            "1100",
        ]
        second = result["movements"][-1]["inputs"]["rice"]
        assert [
            (row["lot_receipt"], row["quantity"], row["cost_cents"]) for row in second
        ] == [(2, 40, "180"), (4, 160, "880")]
        assert result["ending_lots"] == [
            {
                "component": "rice",
                "lot_receipt": 4,
                "quantity": 200,
                "cost_cents": "1100",
            }
        ]
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prep_sheet", type=Path)
    print(json.dumps(run(parser.parse_args().prep_sheet), indent=2))
