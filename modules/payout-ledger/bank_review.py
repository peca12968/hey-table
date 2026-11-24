"""Record documented payout references and export a reviewed bank statement with its reconciliation."""
import argparse
import csv
from io import StringIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile, ZIP_DEFLATED

from bank_close import BANK, NOTICE, read_feed, reconcile_rows


CONFIRMATION = (*BANK, "evidence_ref")


def summary(report):
    return {"balanced": report["balanced"], "batch_counts": report["batch_counts"],
            "unassigned_count": len(report["unassigned_bank_entries"]), "by_account": report["by_account"]}


def review(notices, statement, confirmations, destination):
    if destination.exists():
        raise ValueError(f"choose a new output file: {destination}")
    advice, notice_duplicates = read_feed(notices, NOTICE, ("merchant", "line_id"))
    movements, bank_duplicates = read_feed(statement, BANK, ("account", "entry_id"))
    verified, decision_duplicates = read_feed(confirmations, CONFIRMATION, ("account", "entry_id"))
    before = summary(reconcile_rows(advice, movements, notice_duplicates, bank_duplicates))
    by_key = {(r["account"], r["entry_id"]): r for r in movements}
    decisions = []
    for confirmation in verified:
        key = confirmation["account"], confirmation["entry_id"]
        entry = by_key.get(key)
        if entry is None:
            raise ValueError(f"bank entry absent: {key}")
        if any(entry[k] != confirmation[k] for k in ("posted_on", "amount_twd")):
            raise ValueError(f"date or amount differs from the statement: {key}")
        prior = entry["payout_id"]
        if prior and prior != confirmation["payout_id"]:
            raise ValueError(f"existing payout reference differs: {key}")
        decisions.append({**confirmation, "previous_payout_id": prior,
                          "result": "already_present" if prior else "applied"})
        entry["payout_id"] = confirmation["payout_id"]

    report = reconcile_rows(advice, movements, notice_duplicates, 0)
    audit = {"before": before, "after": summary(report), "decisions": decisions,
             "duplicates_ignored": {"notices": notice_duplicates, "bank": bank_duplicates,
                                    "confirmations": decision_duplicates}}
    bank_csv = StringIO(newline="")
    writer = csv.DictWriter(bank_csv, fieldnames=BANK)
    writer.writeheader()
    writer.writerows(movements)
    # Publish the completed archive exclusively, even if two reviewers choose the same path.
    with TemporaryDirectory(dir=destination.parent) as temporary:
        staged = Path(temporary) / "review.zip"
        with ZipFile(staged, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("bank.csv", bank_csv.getvalue())
            for filename, data in [("report.json", report), ("audit.json", audit)]:
                archive.writestr(filename, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        if os.name == "nt":
            os.rename(staged, destination)  # Windows rename fails when the destination exists.
        else:
            os.link(staged, destination)
    return audit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("notices", type=Path)
    parser.add_argument("statement", type=Path)
    parser.add_argument("confirmations", type=Path)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args(argv)
    try:
        audit = review(args.notices, args.statement, args.confirmations, args.bundle)
    except (OSError, ValueError, csv.Error) as error:
        print(error, file=sys.stderr)
        return 2
    print(json.dumps(audit, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
