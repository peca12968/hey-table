import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import { Board, type BoardEvent } from "./board.ts";
import { makeServer } from "./server.ts";

declare global {
  interface Window { received: BoardEvent[]; feed: EventSource }
}

test("Chromium reconnects with its own Last-Event-ID and recovers both short and long outages", async () => {
  const board = new Board(":memory:", 2);
  const server = makeServer(board);
  const cursors: (string | string[] | undefined)[] = [];
  server.prependListener("request", req => {
    if (req.url === "/events") cursors.push(req.headers["last-event-id"]);
  });
  const browser = await chromium.launch();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.route(url + "/probe", route => route.fulfill({ contentType: "text/html", body: "<title>Board probe</title>" }));
    await page.goto(url + "/probe");
    await page.evaluate(() => {
      window.received = [];
      window.feed = new EventSource("/events");
      for (const type of ["snapshot", "change"] as const) {
        window.feed.addEventListener(type, (message: MessageEvent<string>) => {
          window.received.push({ id: message.lastEventId, event: type, data: JSON.parse(message.data) });
        });
      }
    });
    await page.waitForFunction(() => window.received.length === 1);
    const first = board.update("one", "A", "ready");
    await page.waitForFunction(() => window.received.length === 2);
    server.closeAllConnections();
    const second = board.update("two", "B", "loading");
    const third = board.update("three", "A", "closed");
    await page.waitForFunction(() => window.received.length === 4);
    server.closeAllConnections();
    board.update("four", "B", "closed");
    board.update("five", "C", "ready");
    const sixth = board.update("six", "A", "loading");
    await page.waitForFunction(() => window.received.length >= 5);
    const events = await page.evaluate(() => { window.feed.close(); return window.received; });
    assert.deepEqual(cursors, [undefined, first.id, third.id]);
    assert.deepEqual(events.map(e => e.event), ["snapshot", "change", "change", "change", "snapshot"]);
    assert.deepEqual(events.slice(1).map(e => e.id), [first.id, second.id, third.id, sixth.id]);
    assert.deepEqual(events.at(-1)!.data, [
      { bay: "A", status: "loading" }, { bay: "B", status: "closed" }, { bay: "C", status: "ready" }
    ]);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    board.close();
  }
});
