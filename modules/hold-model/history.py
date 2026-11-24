"""Record concurrent Stockroom calls or check their observable real-time ordering offline."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

from model import Model, validate


def check_action(action):
    if isinstance(action, dict) and action.get("op") == "inventory" and set(action) == {"op"}:
        return
    if isinstance(action, dict) and action.get("op") == "progress" and set(action) == {"op", "key"}:
        validate([{"op": "cancel", "key": action["key"]}])
        return
    validate([action])
    if action["op"] in {"advance", "restart"}:
        raise ValueError("history expects HTTP operations at a fixed service time")


def expected_response(model, action):
    if action["op"] == "inventory":
        return 200, [model.stock()]
    if action["op"] == "progress":
        key = action["key"]
        return (200, model.view(key, progress=True)) if key in model.holds else (404, None)
    return model.apply(action)


def verify(calls, limit=100_000):
    if not isinstance(calls, list) or not calls or type(limit) is not int or limit < 1:
        raise ValueError("expected a nonempty call list and a positive search limit")
    events = set()
    for row in calls:
        if not isinstance(row, dict):
            raise ValueError("expected a call object")
        check_action(row["action"])
        start, end = row["start"], row["end"]
        if (type(start) is not int or type(end) is not int or not 0 <= start < end
                or start in events or end in events):
            raise ValueError("start and end must be distinct, ordered event numbers across the history")
        if type(row["status"]) is not int or not 100 <= row["status"] <= 599 or "body" not in row:
            raise ValueError("each completed call needs its HTTP status and body")
        events.update((start, end))

    calls = sorted(calls, key=lambda row: row["start"])
    # An operation is eligible only after all calls that returned before it began.
    predecessors = [sum(1 << j for j, other in enumerate(calls) if other["end"] < row["start"])
                    for row in calls]
    n = len(calls)
    overlap = n * (n - 1) // 2 - sum(p.bit_count() for p in predecessors)
    bodies = [json.dumps(row["body"], sort_keys=True) for row in calls]
    explored = 0
    longest = []
    path = []
    # Each frame keeps the model at this prefix and its untried next calls.
    stack = [(Model(), 0, iter(range(n)))]
    while stack:
        model, used, choices = stack[-1]
        i = next(choices, None)
        if i is None:
            stack.pop()
            if path:
                path.pop()
            continue
        if used & (1 << i) or predecessors[i] & ~used:
            continue
        if explored == limit:
            return dict(verdict="inconclusive", explored=explored, overlap_pairs=overlap, longest_prefix=longest)
        explored += 1
        branch = deepcopy(model)
        status, body = expected_response(branch, calls[i]["action"])
        if status != calls[i]["status"] or (body is not None and json.dumps(body, sort_keys=True) != bodies[i]):
            continue
        path.append(calls[i]["start"])
        if len(path) == n:
            return dict(verdict="linearizable", explored=explored, overlap_pairs=overlap, order=path)
        if len(path) > len(longest):
            longest = path.copy()
        stack.append((branch, used | (1 << i), iter(range(n))))
    model = Model()
    by_start = {row["start"]: row for row in calls}
    for start in longest:
        expected_response(model, by_start[start]["action"])
    remaining = [row for row in calls if row["start"] not in longest]
    blocked_next = []
    for row in remaining:
        if any(other["end"] < row["start"] for other in remaining):
            continue
        status, body = expected_response(deepcopy(model), row["action"])
        blocked_next.append({"start": row["start"], "expected_status": status, "observed_status": row["status"],
                             "expected_body": body, "observed_body": row["body"]})
    return dict(verdict="impossible", explored=explored, overlap_pairs=overlap,
                longest_prefix=longest, blocked_next=blocked_next)


def scenario(name):
    reserve = {"op": "reserve", "key": "lunch", "qty": 8}
    peek = {"op": "progress", "key": "lunch"}
    inventory = {"op": "inventory"}
    if name == "last-units":
        return [[{**reserve, "qty": 13}, {**reserve, "qty": 13, "key": "dinner"}, inventory],
                [peek, {**peek, "key": "dinner"}, inventory]]
    if name == "renew":
        pending = {"op": "renew", "key": "lunch", "receipt": "wallet", "expected": 105000, "seconds": 30}
        return [[reserve], [pending, pending.copy(), {**pending, "receipt": "cashier"}, peek],
                [pending.copy()], [peek, inventory]]
    ship = {"op": "ship", "key": "lunch", "qty": 5, "receipt": "box"}
    return [[reserve], [ship, ship.copy(), {**ship, "op": "release", "receipt": "cancel-five"}, peek, inventory],
            [{"op": "cancel", "key": "lunch"}], [peek, inventory]]


def capture(name):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import ExitStack
    from tempfile import TemporaryDirectory
    from threading import Barrier, Lock
    from itertools import count
    from check import TestClient, create_app, request

    ticks, lock = count(1), Lock()
    def mark():
        with lock:
            return next(ticks)

    with TemporaryDirectory() as temp, ExitStack() as stack:
        clients = [stack.enter_context(TestClient(create_app(Path(temp)/"stock.db", ttl_seconds=5, clock=lambda: 100),
                                                  raise_server_exceptions=False)) for _ in range(2)]
        calls = []
        def perform(action, instance, gate):
            client = clients[instance]
            gate.wait(timeout=15)
            start = mark()
            if action["op"] == "inventory":
                response = client.get("/inventory")
            elif action["op"] == "progress":
                response = client.get("/reservations/" + action["key"])
            else:
                response = request(client, action)
            end = mark()
            try:
                body = response.json()
            except ValueError:
                body = response.text
            return dict(start=start, end=end, instance=instance, action=action, status=response.status_code, body=body)

        waves = scenario(name)
        with ThreadPoolExecutor(max_workers=max(map(len, waves))) as pool:
            for wave in waves:
                gate = Barrier(len(wave))
                running = [pool.submit(perform, action, i % 2, gate) for i, action in enumerate(wave)]
                calls.extend(task.result() for task in running)
    return sorted(calls, key=lambda row: row["start"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    live = commands.add_parser("capture")
    live.add_argument("scenario", choices=["last-units", "packing", "renew"])
    live.add_argument("--output", type=Path, help="save observations to a new UTF-8 file")
    offline = commands.add_parser("verify")
    offline.add_argument("file", type=Path)
    for command in [live, offline]:
        command.add_argument("--limit", type=int, default=100_000, help="maximum candidate steps to inspect")
    args = parser.parse_args(argv)
    try:
        if args.command == "capture":
            document = {"scenario": args.scenario, "calls": capture(args.scenario)}
        else:
            document = json.loads(args.file.read_text(encoding="utf-8-sig"))
        result = verify(document["calls"], args.limit)
        if args.command == "capture" and args.output:
            with args.output.open("x", encoding="utf8") as out:
                json.dump(document, out, ensure_ascii=False, indent=2)
                out.write("\n")
    except (OSError, KeyError, TypeError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2))
    return {"linearizable": 0, "impossible": 1, "inconclusive": 3}[result["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
