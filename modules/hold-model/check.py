"""Check a local Stockroom checkout against a unit-by-unit inventory model."""
import argparse
from collections import Counter
from contextlib import ExitStack, closing
import json
import os
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from model import Model, generate, validate


SOURCE = Path(os.environ.get("STOCKROOM_SOURCE", Path(__file__).resolve().parent.parent / "stockroom-reservations"))
sys.path.insert(0, str(SOURCE.resolve()))
from stockroom.api import create_app


def request(client, action):
    op = action["op"]
    path = "/reservations/" + action["key"]
    if op == "cancel":
        return client.delete(path)
    if op == "reserve":
        return client.post("/reservations", headers={"Idempotency-Key": action["key"]},
                           json={"sku": "KIT-01", "quantity": action["qty"]})
    headers = {"Idempotency-Key": action["receipt"]}
    if op == "renew":
        return client.post(path + "/renewals", headers=headers,
                           json={"expected_expires_at_ms": action["expected"], "extend_seconds": action["seconds"]})
    suffix = "/fulfillments" if op == "ship" else "/releases"
    return client.post(path + suffix, headers=headers, json={"quantity": action["qty"]})


class Mismatch(Exception):
    def __init__(self, step, op, field, expected, actual):
        self.detail = dict(step=step, operation=op, field=field, expected=expected, actual=actual)
        self.signature = (op, field)


def compare(step, op, field, expected, actual):
    if isinstance(expected, dict) and isinstance(actual, dict) and expected.keys() == actual.keys():
        for key in expected:
            compare(step, op, field + "." + key, expected[key], actual[key])
        return
    if type(expected) is type(actual) and expected == actual:
        return
    raise Mismatch(step, op, field, expected, actual)


def read_json(response, step, op, field):
    try:
        return response.json()
    except ValueError:
        raise Mismatch(step, op, field + ".format", "JSON", response.text[:200]) from None


def run(actions, fault=None):
    model = Model()
    coverage = Counter()
    service_time = 100
    with TemporaryDirectory() as temp, ExitStack() as stack:
        path = Path(temp) / "stock.db"
        def open_clients():
            return [stack.enter_context(TestClient(create_app(path, ttl_seconds=5, clock=lambda: service_time),
                                                   raise_server_exceptions=False)) for _ in range(2)]
        clients = open_clients()
        if fault == "missed-expiry-credit":
            # Simulate a missed credit on expiration of a partly shipped hold in this disposable DB.
            with closing(sqlite3.connect(path)) as db:
                db.execute("""CREATE TRIGGER miss_credit AFTER UPDATE OF timed_out ON reservations
                              WHEN OLD.timed_out=0 AND NEW.timed_out=1 AND NEW.shipped>0
                              BEGIN UPDATE products SET available=available-(NEW.quantity-NEW.shipped-NEW.reduced)
                                    WHERE sku=NEW.sku; END""")
        for step, action in enumerate(actions, 1):
            op = action["op"]
            answer = model.apply(action)
            if op == "advance":
                service_time += action["seconds"]
            writer, reader = clients[step % 2], clients[(step + 1) % 2]
            if op == "restart":
                stack.close()
                clients = open_clients()
                reader = clients[0]
            if answer is not None:
                response = request(writer, action)
                status, body = answer
                coverage[f"{op}/{response.status_code}"] += 1
                compare(step, op, "response.status", status, response.status_code)
                if body is not None:
                    compare(step, op, "response.body", body, read_json(response, step, op, "response.body"))
            else:
                coverage[op] += 1
            inventory = reader.get("/inventory")
            compare(step, op, "inventory.status", 200, inventory.status_code)
            rows = read_json(inventory, step, op, "inventory")
            if not isinstance(rows, list):
                raise Mismatch(step, op, "inventory.format", "array", rows)
            compare(step, op, "inventory.rows", 1, len(rows))
            compare(step, op, "inventory", model.stock(), rows[0])
            for key in model.holds:
                progress = reader.get("/reservations/" + key)
                compare(step, op, f"progress.{key}.status", 200, progress.status_code)
                compare(step, op, f"progress.{key}", model.view(key, progress=True),
                        read_json(progress, step, op, f"progress.{key}"))
    return coverage


def minimize(actions, signature, fault):
    size = max(1, len(actions) // 2)
    trials = 0
    while actions:
        for start in range(0, len(actions), size):
            candidate = actions[:start] + actions[start + size:]
            trials += 1
            try:
                run(candidate, fault)
            except Mismatch as error:
                if error.signature == signature:
                    actions = candidate
                    break
        else:
            if size == 1:
                break
            size = max(1, size // 2)
    return actions, trials


def check(cases, fault):
    coverage = Counter()
    steps = completed = 0
    for seed, actions in cases:
        try:
            coverage.update(run(actions, fault))
        except Mismatch as error:
            prefix = actions[:error.detail["step"]]
            reduced, trials = minimize(prefix, error.signature, fault)
            try:
                run(reduced, fault)
            except Mismatch as replay:
                if replay.signature == error.signature:
                    return {"passed": False, "seed": seed, "fault": fault, "original_failure": error.detail,
                            "failure": replay.detail, "minimization_trials": trials, "actions": reduced}
            raise RuntimeError("reduced trace did not reproduce the original mismatch")
        completed += 1
        steps += len(actions)
    return {"passed": True, "cases": completed, "steps": steps, "coverage": dict(sorted(coverage.items()))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--trace", type=Path, help="JSON with an actions array, including a prior failure report")
    source.add_argument("--seed", type=int, default=1)
    parser.add_argument("--runs", type=int, default=8)
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--output", type=Path, help="save the JSON report to a new UTF-8 file")
    parser.add_argument("--fault", choices=["missed-expiry-credit"], help="enable an isolated demonstration fault")
    args = parser.parse_args()
    if min(args.steps, args.runs) < 1:
        parser.error("runs and steps must be positive")
    if args.trace:
        try:
            actions = json.loads(args.trace.read_text(encoding="utf-8-sig"))["actions"]
            validate(actions)
        except (OSError, ValueError, TypeError, KeyError) as error:
            parser.error(str(error))
        cases = [(None, actions)]
    else:
        cases = ((seed, generate(seed, args.steps)) for seed in range(args.seed, args.seed + args.runs))
    result = check(cases, args.fault)
    contents = json.dumps(result, indent=2)
    if args.output:
        try:
            with args.output.open("x", encoding="utf8") as output:
                output.write(contents + "\n")
        except OSError as error:
            parser.error(str(error))
    print(contents)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
