import { once } from 'node:events';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const HISTORY = `SELECT device,id,time_ms AS timeMs,milli_c AS milliC FROM readings
  WHERE device=? AND time_ms>=? AND time_ms<? ORDER BY time_ms,id`;

export function* history(file, device, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error('Expected a nonempty interval in nonnegative integer milliseconds');
  }
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    yield* db.prepare(HISTORY).iterate(device, start, end);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, device, start, end] = process.argv.slice(2);
  try {
    if (process.argv.length !== 6 || !device || !/^\d+$/.test(start) || !/^\d+$/.test(end)) {
      throw new Error('Usage: node history.mjs DATABASE DEVICE START_MS END_MS');
    }
    for (const row of history(file, device, Number(start), Number(end))) {
      if (!process.stdout.write(JSON.stringify(row) + '\n')) await once(process.stdout, 'drain');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
