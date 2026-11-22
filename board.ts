import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

type Status = "ready" | "loading" | "closed";
type Bay = { bay: string; status: Status };
type Revision = { epoch: string; revision: number };
export type BoardEvent =
  | { id: string; event: "snapshot"; data: Bay[] }
  | { id: string; event: "change"; data: Bay };

export class Conflict extends Error {}

export class Board {
  private db: DatabaseSync;
  private retention: number;

  constructor(path: string, retention = 256) {
    if (!Number.isSafeInteger(retention) || retention < 1) throw new RangeError("Invalid retention");
    this.retention = retention;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bays (bay TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (revision INTEGER PRIMARY KEY, bay TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, bay TEXT NOT NULL, status TEXT NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO board VALUES (1, ?, 0)").run(randomUUID());
  }

  close() { this.db.close(); }

  private transaction<T>(mode: "BEGIN" | "BEGIN IMMEDIATE", action: () => T): T {
    this.db.exec(mode);
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private head(): Revision {
    const row = this.db.prepare("SELECT epoch,revision FROM board WHERE id=1").get()!;
    return { epoch: String(row.epoch), revision: Number(row.revision) };
  }

  update(command: string, bay: string, status: string) {
    const validId = /^[A-Za-z0-9_-]{1,80}$/;
    if (typeof command !== "string" || typeof bay !== "string" || !validId.test(command) ||
        !validId.test(bay) || !["ready", "loading", "closed"].includes(status))
      throw new TypeError("Expected a command ID, bay ID and valid status");
    return this.transaction("BEGIN IMMEDIATE", () => {
      const head = this.head();
      const previous = this.db.prepare("SELECT revision,bay,status FROM commands WHERE id=?").get(command);
      if (previous) {
        if (previous.bay !== bay || previous.status !== status) throw new Conflict("Command ID reused");
        return { id: `${head.epoch}:${previous.revision}`, created: false };
      }
      const revision = head.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new RangeError("Revision exhausted");
      this.db.prepare("UPDATE board SET revision=? WHERE id=1").run(revision);
      this.db.prepare("INSERT INTO bays VALUES (?,?) ON CONFLICT(bay) DO UPDATE SET status=excluded.status").run(bay, status);
      this.db.prepare("INSERT INTO changes VALUES (?,?,?)").run(revision, bay, status);
      this.db.prepare("INSERT INTO commands VALUES (?,?,?,?)").run(command, revision, bay, status);
      this.db.prepare("DELETE FROM changes WHERE revision<=?").run(revision - this.retention);
      return { id: `${head.epoch}:${revision}`, created: true };
    });
  }

  read(cursor?: string, limit = 64): BoardEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid page size");
    return this.transaction("BEGIN", () => {
      const { epoch, revision } = this.head();
      const parts = /^([0-9a-f-]+):(0|[1-9]\d*)$/.exec(cursor ?? "");
      const seen = parts?.[1] === epoch ? Number(parts[2]) : -1;
      const first = this.db.prepare("SELECT MIN(revision) AS first FROM changes").get()!.first;
      if (seen < 0 || seen > revision || (first !== null && seen < Number(first) - 1)) {
        const rows = this.db.prepare("SELECT bay,status FROM bays ORDER BY bay").all();
        return [{ id: `${epoch}:${revision}`, event: "snapshot",
                  data: rows.map(r => ({ bay: String(r.bay), status: r.status as Status })) }];
      }
      return this.db.prepare("SELECT revision,bay,status FROM changes WHERE revision>? ORDER BY revision LIMIT ?")
        .all(seen, limit).map(r => ({ id: `${epoch}:${r.revision}`, event: "change",
                                      data: { bay: String(r.bay), status: r.status as Status } }));
    });
  }
}
