import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Board, Conflict } from "./board.ts";

test("replay from the exact retention boundary or replace the board with one coherent snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "bay-signal-"));
  const path = join(dir, "board.db");
  const a = new Board(path, 2), b = new Board(path, 2);
  try {
    const empty = a.read()[0];
    assert.deepEqual(empty.data, []);
    const first = a.update("cmd1", "B", "ready");
    const second = b.update("cmd2", "A", "loading");
    const third = a.update("cmd3", "B", "closed");
    assert.deepEqual(b.read(first.id, 1).map(e => e.id), [second.id]);
    assert.deepEqual(b.read(second.id).map(e => e.id), [third.id]);
    assert.deepEqual(a.read(third.id), []);
    const snapshot = [{ id: third.id, event: "snapshot", data: [
      { bay: "A", status: "loading" }, { bay: "B", status: "closed" }
    ] }];
    assert.deepEqual(b.read(empty.id), snapshot);
    assert.deepEqual(b.read("other-board:1"), snapshot);
    assert.deepEqual(b.update("cmd1", "B", "ready"), { ...first, created: false });
    assert.throws(() => b.update("cmd1", "A", "ready"), Conflict);
    const restarted = new Board(path, 2);
    try { assert.deepEqual(restarted.read(), snapshot); }
    finally { restarted.close(); }
    const atReadStart = a.current(() => {
      b.update("cmd4", "C", "ready");
      return false;
    });
    assert.deepEqual(atReadStart.snapshot, snapshot[0]);
    assert.notEqual(a.current(() => true).id, atReadStart.id);
  } finally {
    b.close(); a.close(); rmSync(dir, { recursive: true, force: true });
  }
});
