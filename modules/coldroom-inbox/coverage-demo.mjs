import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { consumer } from './consumer.mjs';
import { HISTORY, history } from './history.mjs';
import { Inbox } from './inbox.mjs';

const [legacyPath, reportPath] = process.argv.slice(2);
if (!legacyPath || !reportPath) throw new Error('Usage: node coverage-demo.mjs OLD_INBOX.mjs THAW.py');
const {Inbox: PreviousInbox} = await import(pathToFileURL(resolve(legacyPath)));
const folder = await mkdtemp(join(tmpdir(), 'coldroom-history-'));
const file = join(folder, 'history.db');
const topic = 'coldroom/north/reading';
const payload = (id, timeMs, milliC) => Buffer.from(JSON.stringify({id, timeMs, milliC}));
const wait = (emitter, name) => once(emitter, name, {signal: AbortSignal.timeout(10000)});
function exposure() {
  const output = execFileSync('python', [reportPath, file, 'north', '--start-ms', '1000', '--end-ms', '16000',
    '--window-ms', '5000', '--hold-ms', '4000', '--threshold-mc', '-16000'], {encoding: 'utf8'});
  return JSON.parse(output.trim().split('\n').at(-1));
}
const old = new PreviousInbox(file);
try {
  old.record(topic, payload('a', 0, -18000));
  assert.equal(old.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='readings_by_device_time'").get().n, 0);
} finally { old.close(); }
assert.equal([...history(file, 'north', 0, 1)][0].id, 'a');

const inbox = new Inbox(file);
const broker = await Aedes.createBroker();
const server = net.createServer(broker.handle);
const listening = wait(server, 'listening');
server.listen(0, '127.0.0.1');
await listening;
const url = 'mqtt://127.0.0.1:' + server.address().port;
const subscriber = consumer(url, 'coverage', inbox);
let publisher;
try {
  const subscribed = wait(subscriber, 'subscribed');
  subscriber.connect();
  await subscribed;
  publisher = await mqtt.connectAsync(url, {reconnectPeriod: 0});
  async function send(id, timeMs, milliC, status) {
    const received = wait(subscriber, 'receipt');
    await publisher.publishAsync(topic, payload(id, timeMs, milliC), {qos: 1});
    assert.equal((await received)[0].status, status);
  }
  await send('z', 12000, -13000, 'stored');
  await send('b', 3000, -14000, 'stored');
  await send('y', 9000, -15000, 'stored');
  await send('x', 9000, -17000, 'stored');
  const before = exposure();
  const live = history(file, 'north', 0, 16000);
  let prior;
  try {
    assert.equal(live.next().value.id, 'a');
    await send('late', 7000, -15000, 'stored');
    await send('late', 7000, -15000, 'duplicate');
    await send('late', 7000, -20000, 'conflict');
    prior = [...live].map(row => row.id);
  } finally { live.return(); }
  assert.deepEqual(prior, ['b', 'x', 'y', 'z']);
  const raw = execFileSync(process.execPath, [fileURLToPath(new URL('./history.mjs', import.meta.url)),
    file, 'north', '3000', '12000'], {encoding: 'utf8'}).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(raw.map(row => row.id), ['b', 'late', 'x', 'y']);
  const plan = inbox.db.prepare('EXPLAIN QUERY PLAN ' + HISTORY).all('north', 0, 16000).map(row => row.detail);
  assert.ok(plan.some(line => /COVERING INDEX readings_by_device_time/.test(line)));
  assert.ok(!plan.some(line => /TEMP B-TREE/.test(line)));
  const after = exposure();
  assert.deepEqual(before.possible_above_ms, [8000, 13000]);
  assert.deepEqual(after.possible_above_ms, [10000, 13000]);
  assert.equal(after.unobserved_ms, 0);
  assert.equal(after.straddling_ms, 3000);
  console.log(JSON.stringify({before: before.possible_above_ms, after: after.possible_above_ms,
    previouslyOpenHistory: ['a', ...prior], freshRange: raw.map(row => row.id), plan}, null, 2));
} finally {
  if (publisher) await publisher.endAsync(true);
  await subscriber.endAsync(true);
  await new Promise(done => broker.close(done));
  await new Promise(done => server.close(done));
  inbox.close();
  await rm(folder, {recursive: true, force: true});
}
