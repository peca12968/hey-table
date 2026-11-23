"""Find review candidates for bank movements without a payout reference."""
import argparse
from collections import defaultdict
import csv
from datetime import date
import json
from pathlib import Path
import sys

from matching import classify


def text(value):
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError("expected a nonempty identifier without outer spaces")
    return value


def day(value):
    if date.fromisoformat(value).isoformat() != value:
        raise ValueError("expected a YYYY-MM-DD date")
    return value


def windows_from(path):
    result = {}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = csv.reader(stream, strict=True)
        if next(rows, []) != ["account", "payout_id", "first_date", "last_date"]:
            raise ValueError("expected account,payout_id,first_date,last_date")
        for account, payout, first, last in rows:
            key = text(account), text(payout)
            if day(first) > day(last) or key in result:
                raise ValueError(f"reversed or repeated date window for {key}")
            result[key] = first, last
    return result


def review(report, windows):
    slots, deposits = defaultdict(list), defaultdict(list)
    open_batches, all_batches = set(), set()
    for batch in report["batches"]:
        account, payout = text(batch["account"]), text(batch["payout_id"])
        key = account, payout
        if key in all_batches:
            raise ValueError(f"duplicate batch {key}")
        all_batches.add(key)
        if batch["status"] in {"matched", "zero_net", "bank_only"}:
            continue
        if batch["status"] not in {"missing_bank", "amount_mismatch"}:
            raise ValueError(f"unknown batch status for {key}")
        expected, bank = batch["expected_twd"], batch["bank_twd"]
        if type(expected) is not int or type(bank) is not int or expected == bank:
            raise ValueError(f"invalid outstanding amount for {key}")
        open_batches.add(key)
        if key in windows:
            slots[account, expected - bank].append((*windows[key], payout))
    if windows.keys() - all_batches:
        raise ValueError("date window refers to batch absent from report")

    seen = set()
    for row in report["unassigned_bank_entries"]:
        account, entry = text(row["account"]), text(row["entry_id"])
        amount = row["amount_twd"]
        if row["payout_id"] != "" or (account, entry) in seen or type(amount) is not int or amount == 0:
            raise ValueError(f"invalid unassigned bank entry {(account, entry)}")
        seen.add((account, entry))
        deposits[account, amount].append((day(row["posted_on"]), entry))
    maximum, checks = 0, []
    for (account, amount), entries in sorted(deposits.items()):
        size, options = classify(entries, slots[account, amount])
        maximum += size
        for posted, entry in sorted(entries):
            partners, can_skip = options[entry]
            status = "unique_in_model" if len(partners) == 1 and not can_skip else "ambiguous"
            checks.append({"account": account, "entry_id": entry, "posted_on": posted,
                           "amount_twd": amount, "possible_payouts": partners,
                           "can_be_unassigned": can_skip, "status": status if partners else "no_candidate"})
    return {"maximum_pairs": maximum, "entries": checks, "missing_windows": [
        {"account": a, "payout_id": p} for a, p in sorted(open_batches - windows.keys())]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("windows", type=Path)
    args = parser.parse_args(argv)
    try:
        report = json.loads(args.report.read_text(encoding="utf-8-sig"))
        if not isinstance(report["batches"], list) or not isinstance(report["unassigned_bank_entries"], list):
            raise ValueError("expected arrays of batches and unassigned bank entries")
        result = review(report, windows_from(args.windows))
    except (OSError, TypeError, KeyError, ValueError, csv.Error) as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
