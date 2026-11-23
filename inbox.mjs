import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const identifier = /^[a-zA-Z0-9_.-]{1,64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

function parse(topic, bytes) {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== 'coldroom' || parts[2] !== 'reading' || !identifier.test(parts[1])) {
    return null;
  }
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value.id !== 'string' || !identifier.test(value.id) ||
        !Number.isSafeInteger(value.timeMs) || value.timeMs < 0 || !Number.isSafeInteger(value.milliC) ||
        Object.keys(value).some(key => !['id', 'timeMs', 'milliC'].includes(key))) return null;
    return { device: parts[1], ...value };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

export class Inbox {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS readings (
        device TEXT NOT NULL, id TEXT NOT NULL, time_ms INTEGER NOT NULL, milli_c INTEGER NOT NULL,
        PRIMARY KEY(device,id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS rejected (
        digest TEXT PRIMARY KEY, topic TEXT NOT NULL, reason TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    this.find = this.db.prepare('SELECT time_ms, milli_c FROM readings WHERE device=? AND id=?');
    this.insert = this.db.prepare('INSERT INTO readings VALUES (?,?,?,?)');
    this.reject = this.db.prepare('INSERT INTO rejected VALUES (?,?,?) ON CONFLICT(digest) DO NOTHING');
  }

  record(topic, bytes) {
    const reading = parse(topic, bytes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let status = 'invalid';
      if (reading) {
        const { device, id, timeMs, milliC } = reading;
        const old = this.find.get(device, id);
        if (!old) {
          this.insert.run(device, id, timeMs, milliC);
          status = 'stored';
        } else {
          status = old.time_ms === timeMs && old.milli_c === milliC ? 'duplicate' : 'conflict';
        }
      }
      if (status === 'invalid' || status === 'conflict') {
        const digest = createHash('sha256').update(topic).update('\0').update(bytes).digest('hex');
        this.reject.run(digest, topic, status);
      }
      this.db.exec('COMMIT');
      return { status, device: reading?.device, id: reading?.id };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
}
