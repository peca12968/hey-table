"""Run a loopback kitchen station inbox or render an accepted slip for printing."""
import argparse
from contextlib import closing
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3

from rail import STATION, digest, encode, validate_order


def initialize(path, station):
    if not STATION.fullmatch(station):
        raise ValueError("Invalid station code")
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), station TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS slips(key TEXT PRIMARY KEY, sha256 TEXT NOT NULL,
                         state TEXT NOT NULL, ticket BLOB NOT NULL);
        """)
        db.execute("INSERT OR IGNORE INTO identity VALUES(1,?)", (station,))
        if db.execute("SELECT station FROM identity").fetchone()[0] != station:
            raise ValueError("Inbox belongs to a different station")


def handler(path, station):
    class Inbox(BaseHTTPRequestHandler):
        def respond(self, code, value):
            body = encode(value)
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def route(self):
            match = re.fullmatch(r"/tickets/([0-9a-f]{64})", self.path)
            if not match:
                return self.respond(404, {"error": "Unknown resource"})
            key = match[1]
            with closing(sqlite3.connect(path, timeout=10)) as db:
                if self.command != "GET":
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                        if not 0 < length <= 1_000_000:
                            raise ValueError("Invalid ticket size")
                        body = self.rfile.read(length)
                        ticket = json.loads(body)
                        if ticket["station"] != station:
                            raise ValueError("Wrong station")
                        validate_order(dict(ticket, status="preparing"))
                    except (ValueError, TypeError, KeyError) as error:
                        return self.respond(400, {"error": str(error)})
                    with db:
                        state = "closed" if self.command == "DELETE" else "accepted"
                        db.execute("INSERT OR IGNORE INTO slips VALUES(?,?,?,?)", (key, digest(body), state, body))
                row = db.execute("SELECT sha256,state FROM slips WHERE key=?", (key,)).fetchone()
                if row is None:
                    return self.respond(404, {"absent": key, "station": station})
                if self.command != "GET" and row[0] != digest(body):
                    return self.respond(409, {"error": "Key reused with different contents"})
                self.respond(200, {"key": key, "station": station, "sha256": row[0], "state": row[1]})

        do_GET = do_POST = do_DELETE = route

    return Inbox


def render(ticket):
    service = escape(ticket["table"]) + " 桌內用" if ticket["mode"] == "table" else "線上自取"
    lines = []
    for line in ticket["items"]:
        note = line.get("note")
        item_note = f'<p class="note">備註　{escape(note)}</p>' if isinstance(note, str) and note.strip() else ""
        lines.append(f'<li><b>×{line["qty"]}</b> {escape(line["name"])}{item_note}</li>')
    note = f'<p class="note">備註　{escape(ticket["note"])}</p>' if ticket["note"] else ""
    return f"""<!doctype html>
<html lang="zh-Hant"><meta charset="utf-8"><title>廚房單 #{ticket["id"]:04d}</title>
<style>@page {{margin:4mm}} body {{max-width:72mm;font:16px system-ui,sans-serif;color:#142c21}}
h1 {{font-size:1.6rem}} ul {{padding:0;list-style:none}} li {{padding:.5em 0;border-bottom:1px solid}}
.note {{white-space:pre-wrap;overflow-wrap:anywhere}}</style>
<main><p>{escape(ticket["station"])} · {service}</p><h1>廚房單 #{ticket["id"]:04d}</h1>
<ul>{"".join(lines)}</ul>{note}</main></html>"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    commands = parser.add_subparsers(dest="cmd", required=True)
    server = commands.add_parser("serve")
    server.add_argument("station")
    server.add_argument("--port", type=int, default=8765)
    commands.add_parser("list")
    show = commands.add_parser("export")
    show.add_argument("key")
    show.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        if args.cmd == "serve":
            initialize(args.db, args.station)
            with ThreadingHTTPServer(("127.0.0.1", args.port), handler(args.db, args.station)) as httpd:
                print(json.dumps({"url": f"http://127.0.0.1:{httpd.server_port}"}), flush=True)
                httpd.serve_forever()
            return
        with closing(sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            if args.cmd == "list":
                for key, body in db.execute("SELECT key,ticket FROM slips WHERE state='accepted' ORDER BY rowid"):
                    print(json.dumps({"key": key, **json.loads(body)}, ensure_ascii=False))
            else:
                row = db.execute("SELECT ticket FROM slips WHERE key=? AND state='accepted'", (args.key,)).fetchone()
                if not row:
                    raise ValueError("No accepted ticket with this key")
                args.output.write_text(render(json.loads(row[0])), encoding="utf-8")
    except KeyboardInterrupt:
        pass
    except (ValueError, OSError, sqlite3.Error) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
