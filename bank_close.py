"""Reconcile normalized TWD payout notices with booked bank movements, by account and payout ID."""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import date
import json
from pathlib import Path
import re
import sys


NOTICE = ("account", "payout_id", "merchant", "line_id", "method", "kind", "amount_twd")
BANK = ("account", "entry_id", "payout_id", "posted_on", "amount_twd")
SIGNS = {"collection": 1, "refund": -1, "fee": -1, "fee_return": 1}


def read_feed(path, fields, identity):
    entries = {}
    repeats = 0
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, strict=True)
        if reader.fieldnames != list(fields):
            raise ValueError(f"{path.name}: expected columns {','.join(fields)}")
        for row in reader:
            try:
                if None in row or any(v is None or v != v.strip() for v in row.values()):
                    raise ValueError("extra, incomplete or padded field")
                for key in fields:
                    if not row[key] and not (fields == BANK and key == "payout_id"):
                        raise ValueError(f"missing {key}")
                amount = row["amount_twd"]
                if not re.fullmatch(r"-?[1-9][0-9]{0,11}", amount):
                    raise ValueError("expected a nonzero whole TWD amount of up to 12 digits")
                row["amount_twd"] = int(amount)
                if fields == NOTICE:
                    if row["kind"] not in SIGNS or row["amount_twd"] < 0:
                        raise ValueError("unknown line kind or negative payout notice amount")
                else:
                    if date.fromisoformat(row["posted_on"]).isoformat() != row["posted_on"]:
                        raise ValueError("expected ISO date YYYY-MM-DD")
                key = tuple(row[field] for field in identity)
                if key in entries:
                    if entries[key] != row:
                        raise ValueError(f"conflicting source ID {key}")
                    repeats += 1
                else:
                    entries[key] = row
            except ValueError as error:
                raise ValueError(f"{path.name} line {reader.line_num}: {error}") from error
    return [entries[k] for k in sorted(entries)], repeats


def reconcile(notices, statement):
    advice, repeated_advice = read_feed(notices, NOTICE, ("merchant", "line_id"))
    movements, repeated_bank = read_feed(statement, BANK, ("account", "entry_id"))
    return reconcile_rows(advice, movements, repeated_advice, repeated_bank)


def reconcile_rows(advice, movements, repeated_advice, repeated_bank):
    notice_groups, bank_groups = defaultdict(list), defaultdict(list)
    unassigned = []
    totals = defaultdict(lambda: {"expected_twd": 0, "bank_twd": 0, "unassigned_twd": 0})
    for row in advice:
        notice_groups[row["account"], row["payout_id"]].append(row)
    for row in movements:
        account = totals[row["account"]]
        account["bank_twd"] += row["amount_twd"]
        if row["payout_id"]:
            bank_groups[row["account"], row["payout_id"]].append(row)
        else:
            account["unassigned_twd"] += row["amount_twd"]
            unassigned.append(row)

    batches = []
    statuses = Counter()
    for account, payout in sorted(notice_groups.keys() | bank_groups.keys()):
        lines = notice_groups[account, payout]
        booked = bank_groups[account, payout]
        components = Counter()
        for line in lines:
            components[line["kind"]] += line["amount_twd"]
        expected = sum(SIGNS[kind] * amount for kind, amount in components.items())
        received = sum(entry["amount_twd"] for entry in booked)
        totals[account]["expected_twd"] += expected
        if not lines:
            status = "bank_only"
        elif not booked:
            status = "missing_bank" if expected else "zero_net"
        elif expected != received:
            status = "amount_mismatch"
        else:
            status = "matched"
        statuses[status] += 1
        batches.append({"account": account, "payout_id": payout, "status": status,
                        "components_twd": dict(components), "expected_twd": expected, "bank_twd": received,
                        "delta_twd": received - expected, "notice_lines": lines, "bank_entries": booked})
    for total in totals.values():
        total["delta_twd"] = total["bank_twd"] - total["expected_twd"]
    return {"balanced": not unassigned and all(s in {"matched", "zero_net"} for s in statuses),
            "by_account": dict(sorted(totals.items())), "batch_counts": dict(statuses),
            "duplicates_ignored": {"notice": repeated_advice, "bank": repeated_bank},
            "batches": batches, "unassigned_bank_entries": unassigned}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("notices", type=Path)
    parser.add_argument("statement", type=Path)
    parser.add_argument("--strict", action="store_true", help="exit 3 when a batch or bank entry needs review")
    args = parser.parse_args(argv)
    try:
        report = reconcile(args.notices, args.statement)
    except (OSError, ValueError, csv.Error) as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 3 if args.strict and not report["balanced"] else 0


if __name__ == "__main__":
    sys.exit(main())
