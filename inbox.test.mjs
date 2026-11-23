import assert from 'node:assert/strict';
import test from 'node:test';
import { Inbox } from './inbox.mjs';
import { consumer } from './consumer.mjs';
import { exercise } from './demo.mjs';

const topic = 'coldroom/freezer/reading';
const bytes = data => Buffer.from(JSON.stringify(data));

test('business identity survives reordered JSON, packet IDs, and zero values', t => {
  const inbox = new Inbox(':memory:');
  t.after(() => inbox.close());
  const row = {id: '0', timeMs: 0, milliC: 0};
  assert.equal(inbox.record(topic, bytes(row)).status, 'stored');
  assert.equal(inbox.record(topic, bytes({milliC: 0, timeMs: 0, id: '0'})).status, 'duplicate');
  for (let i = 0; i < 2; i++) {
    assert.equal(inbox.record(topic, bytes({...row, timeMs: 1})).status, 'conflict');
    assert.equal(inbox.record(topic, Buffer.from([0xff])).status, 'invalid');
  }
  assert.equal(inbox.db.prepare('SELECT count(*) n FROM readings').get().n, 1);
  assert.equal(inbox.db.prepare('SELECT count(*) n FROM rejected').get().n, 2);
  for (const value of [null, [], {...row, id: 1}, {...row, timeMs: -1}, {...row, milliC: 1.5}, {...row, extra: 1}]) {
    assert.equal(inbox.record(topic, bytes(value)).status, 'invalid');
  }
});

test('a failed SQLite insert rolls back and fails the MQTT acknowledgement continuation', t => {
  const inbox = new Inbox(':memory:');
  t.after(() => inbox.close());
  const client = consumer('mqtt://127.0.0.1:1883', 'unit-case', inbox);
  let disconnected = false;
  client.stream = {destroy() { disconnected = true; }};
  const packet = {topic, messageId: 7, qos: 1, payload: bytes({id: 'r', timeMs: 5, milliC: -19000})};
  inbox.db.exec("CREATE TRIGGER fault BEFORE INSERT ON readings BEGIN SELECT RAISE(ABORT,'injected'); END");
  let observed;
  client.handleMessage(packet, error => { observed = error; });
  assert.match(observed.message, /injected/);
  assert.equal(disconnected, true);
  assert.equal(inbox.db.prepare('SELECT count(*) n FROM readings').get().n, 0);
  inbox.db.exec('DROP TRIGGER fault');
  client.handleMessage(packet, error => { observed = error; });
  assert.equal(observed, undefined);
  assert.equal(inbox.db.prepare('SELECT milli_c FROM readings').get().milli_c, -19000);
});

test('persistent session redelivers an unacknowledged commit across process death', async () => {
  const result = await exercise();
  assert.deepEqual(result.beforeCrash, {committed: 1, acknowledgements: 0});
  assert.deepEqual(result.afterRestart, {deliveries: 6, acknowledgements: 6, readings: 3, rejected: 2});
});
