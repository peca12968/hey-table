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
      if (req.method === "GET" && req.url === "/events") {
        const header = req.headers["last-event-id"];
        await stream(board, typeof header === "string" ? header : undefined, res);
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
