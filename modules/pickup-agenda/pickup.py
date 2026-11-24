import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory

from agenda import calendar_bytes, propose, read_event, revise


def serve(path, port):
    class Feed(BaseHTTPRequestHandler):
        def do_GET(self):
            route = re.fullmatch(r"/calendar/([0-9a-f-]{36})\.ics", self.path)
            if not route:
                self.send_error(404)
                return
            try:
                data = calendar_bytes(read_event(path, route[1]))
            except KeyError:
                self.send_error(404)
                return
            except sqlite3.Error:
                self.send_error(503)
                return
            tag = '"' + hashlib.sha256(data).hexdigest() + '"'
            tags = {
                item.strip().removeprefix("W/")
                for item in self.headers.get("If-None-Match", "").split(",")
            }
            cached = tag in tags or "*" in tags
            self.send_response(304 if cached else 200)
            self.send_header("ETag", tag)
            self.send_header("Cache-Control", "private, no-cache")
            if not cached:
                self.send_header("Content-Type", "text/calendar; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if not cached and self.command == "GET":
                self.wfile.write(data)

        do_HEAD = do_GET

        def log_message(self, fmt, *args):
            pass  # Keep the per-event subscription URL out of access logs.

    with ThreadingHTTPServer(("127.0.0.1", port), Feed) as server:
        print(f"http://127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Manage a local pickup calendar")
    parser.add_argument("db", type=Path)
    sub = parser.add_subparsers(dest="action", required=True)
    initial = sub.add_parser("propose")
    initial.add_argument("store")
    initial.add_argument("number", type=int)
    initial.add_argument("snapshot", type=Path)
    initial.add_argument("estimate", type=Path)
    for name in ("confirm", "cancel", "export"):
        p = sub.add_parser(name)
        p.add_argument("uid")
        if name == "export":
            p.add_argument("output", type=Path)
        else:
            p.add_argument("--expect", type=int, required=True)
        if name == "confirm":
            p.add_argument("--start", required=True)
            p.add_argument("--end", required=True)
    feed = sub.add_parser("serve")
    feed.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    try:
        if args.action == "serve":
            serve(args.db, args.port)
            return 0
        if args.action == "export":
            data = calendar_bytes(read_event(args.db, args.uid))
            with TemporaryDirectory(dir=args.output.parent) as folder:
                staged = Path(folder) / "pickup.ics"
                staged.write_bytes(data)
                if os.name == "nt":
                    staged.rename(args.output)
                else:
                    os.link(staged, args.output)
            return 0
        if args.action == "propose":
            docs = (
                json.loads(p.read_text(encoding="utf-8-sig"))
                for p in (args.snapshot, args.estimate)
            )
            event = propose(args.db, args.store, args.number, *docs)
        else:
            event = revise(
                args.db,
                args.uid,
                args.expect,
                "CANCELLED" if args.action == "cancel" else "CONFIRMED",
                getattr(args, "start", None),
                getattr(args, "end", None),
            )
        print(json.dumps(event))
    except (ValueError, KeyError, OSError, sqlite3.Error, OverflowError) as exc:
        parser.exit(2, f"pickup-agenda: {exc}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
