import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Board } from "./board.ts";
import { makeServer } from "./server.ts";

test("an HTTP subscriber receives a live change, reconnects and recovers after retention expires", async () => {
  const board = new Board(":memory:", 2);
  const server = makeServer(board);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const clients: AbortController[] = [];
  async function subscribe(cursor?: string) {
    const controller = new AbortController();
    clients.push(controller);
    const response = await fetch(base + "/events", { headers: cursor ? { "Last-Event-ID": cursor } : {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    return { close: () => controller.abort(), next: async () => {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const lines = buffer.slice(0, boundary).split("\n");
          buffer = buffer.slice(boundary + 2);
          if (!lines[0].startsWith("id: ")) continue;
          return { id: lines[0].slice(4), event: lines[1].slice(7), data: JSON.parse(lines[2].slice(6)) };
        }
        const { value, done } = await reader.read();
        assert.ok(!done, "stream ended early");
        buffer += value;
      }
    }};
  }
  async function push(command: string, status: string, expected = 201) {
    const response = await fetch(base + "/updates", { method: "POST", body: JSON.stringify({ command, bay: "A", status }) });
    assert.equal(response.status, expected);
    return (await response.json()).id;
  }
  try {
    const live = await subscribe();
    const empty = await live.next();
    assert.equal(empty.event, "snapshot");
    const first = await push("u1", "ready");
    assert.deepEqual(await live.next(), { id: first, event: "change", data: { bay: "A", status: "ready" } });
    live.close();
    const second = await push("u2", "loading");
    const third = await push("u3", "closed");
    const resumed = await subscribe(first);
    assert.deepEqual([(await resumed.next()).id, (await resumed.next()).id], [second, third]);
    resumed.close();
    assert.equal(await push("u1", "ready", 200), first);
    await push("u1", "closed", 409);
    const reset = await subscribe(empty.id);
    assert.deepEqual(await reset.next(), { id: third, event: "snapshot", data: [{ bay: "A", status: "closed" }] });
  } finally {
    for (const client of clients) client.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    board.close();
  }
});
