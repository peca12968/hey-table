import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { Board, Conflict } from "./board.ts";

async function stream(board: Board, cursor: string | undefined, res: ServerResponse) {
  const controller = new AbortController();
  const { signal } = controller;
  res.once("close", () => controller.abort());
  async function write(data: string) {
    if (!res.write(data)) await once(res, "drain", { signal });
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  await write("retry: 1000\n\n");
  let lastWrite = Date.now();
  while (!signal.aborted) {
    const events = board.read(cursor);
    for (const e of events) {
      await write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      cursor = e.id;
    }
    if (events.length) lastWrite = Date.now();
    else if (Date.now() - lastWrite >= 15000) {
      await write(": heartbeat\n\n");
      lastWrite = Date.now();
    }
    if (events.length < 64) await wait(150, undefined, { signal });
  }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

function matchesVersion(field: string | undefined, opaqueTag: string) {
  if (!field) return false;
  if (field.trim() === "*") return true;
  // Commas are valid inside quoted tags. Consume each whole list member.
  const member = /[ \t]*(?:(?:W\/)?"([\x21\x23-\x7e\x80-\xff]*)"[ \t]*)?(,|$)/y;
  let matched = false;
  while (member.lastIndex < field.length) {
    const token = member.exec(field);
    if (!token) return false;
    if (token[1] === opaqueTag) matched = true;
  }
  return matched;
}

function sendSnapshot(board: Board, req: IncomingMessage, res: ServerResponse) {
  const tag = (id: string) => "board-v1:" + id;
  const result = board.current(id => matchesVersion(req.headers["if-none-match"], tag(id)));
  res.setHeader("ETag", `W/"${tag(result.id)}"`);
  res.setHeader("Cache-Control", "private, no-cache");
  if (!result.snapshot) {
    res.writeHead(304).end();
    return;
  }
  const body = JSON.stringify(result.snapshot);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function update(board: Board, req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) { json(res, 413, { error: "Body too large" }); return; }
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== "object") throw new TypeError("Expected an update object");
  const receipt = board.update(value.command, value.bay, value.status);
  json(res, receipt.created ? 201 : 200, receipt);
}

export function makeServer(board: Board) {
  return createServer(async (req, res) => {
    try {
      const target = req.url ?? "";
      const path = target.split("?", 1)[0];
      if ((req.method === "GET" || req.method === "HEAD") && path === "/snapshot") {
        sendSnapshot(board, req, res);
      } else if (req.method === "GET" && path === "/events") {
        const header = req.headers["last-event-id"];
        const query = new URLSearchParams(target.slice(path.length + 1));
        const cursor = typeof header === "string" ? header : query.get("since") ?? undefined;
        await stream(board, cursor, res);
      } else if (req.method === "POST" && req.url === "/updates") {
        await update(board, req, res);
      } else {
        json(res, 404, { error: "Unknown route" });
      }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const code = error instanceof Conflict ? 409 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500;
      json(res, code, { error: code === 500 ? "Internal error" : (error as Error).message });
    }
  });
}

if (import.meta.main) {
  const board = new Board(process.argv[2] ?? "board.db", Number(process.env.BAY_RETENTION ?? "256"));
  const server = makeServer(board);
  server.listen(Number(process.env.PORT ?? "8080"), "127.0.0.1", () => {
    console.log("Listening on", server.address());
  });
}
