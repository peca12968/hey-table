"""Find review candidates for bank movements without a payout reference."""
import argparse
from collections import defaultdict
import csv
from dataclasses import dataclass, fields
from datetime import date
import json
from pathlib import Path
import re
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


@dataclass(frozen=True)
class Exclusion:
    account: str
    entry_id: str
    payout_id: str
    posted_on: str
    amount_twd: int
    evidence_ref: str


def exclusions_from(path):
    records = []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = csv.reader(stream, strict=True)
        if next(rows, []) != [field.name for field in fields(Exclusion)]:
            raise ValueError("invalid exclusion columns")
        for account, entry, payout, posted, amount, evidence in rows:
            if not re.fullmatch(r"-?[1-9][0-9]{0,11}", amount):
                raise ValueError("expected a nonzero signed statement amount")
            records.append(Exclusion(text(account), text(entry), text(payout), day(posted),
                                     int(amount), text(evidence)))
    return records


def review(report, windows, exclusions=None):
    slots, deposits = defaultdict(list), defaultdict(list)
    open_batches, all_batches = {}, set()
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
        open_batches[key] = expected - bank
        if key in windows:
            slots[account, expected - bank].append((*windows[key], payout))
    if windows.keys() - all_batches:
        raise ValueError("date window refers to batch absent from report")

    bank_entries = {}
    for row in report["unassigned_bank_entries"]:
        account, entry = text(row["account"]), text(row["entry_id"])
        amount = row["amount_twd"]
        if row["payout_id"] != "" or (account, entry) in bank_entries or type(amount) is not int or amount == 0:
            raise ValueError(f"invalid unassigned bank entry {(account, entry)}")
        posted = day(row["posted_on"])
        bank_entries[account, entry] = posted, amount
        deposits[account, amount].append((posted, entry))
    forbidden = defaultdict(set)
    evidence = defaultdict(set)
    for rule in exclusions or ():
        bank_key = rule.account, rule.entry_id
        batch_key = rule.account, rule.payout_id
        if bank_entries.get(bank_key) != (rule.posted_on, rule.amount_twd):
            raise ValueError(f"exclusion does not match an unassigned bank entry: {bank_key}")
        window = windows.get(batch_key)
        if (open_batches.get(batch_key) != rule.amount_twd or window is None or
                not window[0] <= rule.posted_on <= window[1]):
            raise ValueError(f"excluded batch is not a current date and amount candidate: {batch_key}")
        forbidden[rule.account, rule.amount_twd].add((rule.entry_id, rule.payout_id))
        evidence[rule.account, rule.entry_id, rule.payout_id].add(rule.evidence_ref)
    maximum, checks = 0, []
    baseline_maximum, changes = 0, []
    for (account, amount), entries in sorted(deposits.items()):
        group_slots = slots[account, amount]
        excluded = forbidden[account, amount]
        size, options = classify(entries, group_slots, excluded)
        if excluded:
            original_size, original = classify(entries, group_slots)
        else:
            original_size, original = size, options
        baseline_maximum += original_size
        maximum += size
        for posted, entry in sorted(entries):
            partners, can_skip = options[entry]
            if original[entry] != options[entry]:
                old_partners, old_skip = original[entry]
                changes.append({"account": account, "entry_id": entry,
                                "added_payouts": sorted(set(partners) - set(old_partners)),
                                "removed_payouts": sorted(set(old_partners) - set(partners)),
                                "could_be_unassigned_before": old_skip, "can_be_unassigned_now": can_skip})
            status = "unique_in_model" if len(partners) == 1 and not can_skip else "ambiguous"
            checks.append({"account": account, "entry_id": entry, "posted_on": posted,
                           "amount_twd": amount, "possible_payouts": partners,
                           "can_be_unassigned": can_skip, "status": status if partners else "no_candidate"})
    result = {"maximum_pairs": maximum, "entries": checks, "missing_windows": [
        {"account": a, "payout_id": p} for a, p in sorted(open_batches.keys() - windows.keys())]}
    if exclusions is not None:
        result["maximum_before_exclusions"] = baseline_maximum
        result["changed_entries"] = changes
        result["excluded_pairs"] = [
            {"account": a, "entry_id": e, "payout_id": p, "posted_on": bank_entries[a, e][0],
             "amount_twd": bank_entries[a, e][1], "evidence_refs": sorted(refs)}
            for (a, e, p), refs in sorted(evidence.items())]
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("windows", type=Path)
    parser.add_argument("--exclusions", type=Path, help="documented pairs ruled out by the bank or provider")
    args = parser.parse_args(argv)
    try:
        report = json.loads(args.report.read_text(encoding="utf-8-sig"))
        if not isinstance(report["batches"], list) or not isinstance(report["unassigned_bank_entries"], list):
            raise ValueError("expected arrays of batches and unassigned bank entries")
        exclusions = exclusions_from(args.exclusions) if args.exclusions is not None else None
        result = review(report, windows_from(args.windows), exclusions)
    except (OSError, TypeError, KeyError, ValueError, csv.Error) as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
