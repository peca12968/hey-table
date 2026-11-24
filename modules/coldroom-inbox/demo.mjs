import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { consumer } from './consumer.mjs';
import { Inbox } from './inbox.mjs';

const event = (emitter, name) => once(emitter, name, {signal: AbortSignal.timeout(10000)});

export async function exercise() {
  const folder = await mkdtemp(join(tmpdir(), 'coldroom-'));
  const database = join(folder, 'meter.db');
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  const listening = event(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const url = 'mqtt://127.0.0.1:' + server.address().port;
  const id = 'freezer-sink';
  const topic = 'coldroom/north/reading';
  const payload = (key, temp) => JSON.stringify({id: key, timeMs: 5000, milliC: temp});
  const brokerAcks = [];
  broker.on('ack', (packet, client) => {
    if (client.id === id) brokerAcks.push(packet.messageId);
  });
  let child, publisher, client, inbox;
  try {
    publisher = await mqtt.connectAsync(url, {clientId: 'thermometer', reconnectPeriod: 0});
    child = fork(new URL('./fixtures/interrupted.mjs', import.meta.url), [url, id, database],
                 {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
    const [ready] = await event(child, 'message');
    assert.equal(ready.event, 'ready');
    const committed = event(child, 'message');
    await publisher.publishAsync(topic, payload('n-1', -18000), {qos: 1});
    const [first] = await committed;
    assert.equal(first.event, 'committed');
    const observer = new DatabaseSync(database, {readOnly: true});
    try {
      assert.equal(observer.prepare('SELECT milli_c FROM readings WHERE id=?').get('n-1').milli_c, -18000);
    } finally { observer.close(); }
    assert.deepEqual(brokerAcks, []);
    const exit = event(child, 'exit');
    const disconnect = event(broker, 'clientDisconnect');
    child.kill('SIGKILL');
    await exit;
    const [disconnected] = await disconnect;
    assert.equal(disconnected.id, id);
    await publisher.publishAsync(topic, payload('n-2', -17500), {qos: 1});

    inbox = new Inbox(database);
    client = consumer(url, id, inbox);
    const receipts = [];
    client.on('receipt', receipt => receipts.push(receipt));
    const firstPair = new Promise(resolvePair => {
      client.on('receipt', () => { if (receipts.length === 2) resolvePair(); });
    });
    const connected = event(client, 'subscribed');
    client.connect();
    const [session] = await connected;
    assert.equal(session.sessionPresent, true);
    // Broker redelivery and the offline publication can arrive before the new SUBACK.
    if (receipts.length < 2) {
      await Promise.race([firstPair, new Promise((_, reject) =>
        AbortSignal.timeout(10000).addEventListener('abort', () => reject(new Error('Offline deliveries timed out'))))]);
    }
    assert.deepEqual(receipts.map(r => [r.id, r.status]).sort(), [['n-1', 'duplicate'], ['n-2', 'stored']]);
    for (const [address, body, status] of [
      [topic, payload('n-1', -18000), 'duplicate'],
      [topic, payload('n-1', -15000), 'conflict'],
      [topic, '{', 'invalid'],
      ['coldroom/south/reading', payload('n-1', -20000), 'stored'],
    ]) {
      const delivery = event(client, 'receipt');
      await publisher.publishAsync(address, body, {qos: 1});
      const [receipt] = await delivery;
      assert.equal(receipt.status, status);
    }
    while (brokerAcks.length < receipts.length) await event(broker, 'ack');
    assert.equal(brokerAcks.length, 6);
    assert.equal(inbox.db.prepare('SELECT count(*) n FROM readings').get().n, 3);
    assert.equal(inbox.db.prepare('SELECT count(*) n FROM rejected').get().n, 2);
    assert.equal(inbox.db.prepare('SELECT milli_c FROM readings WHERE device=? AND id=?').get('north', 'n-1').milli_c, -18000);
    return {beforeCrash: {committed: 1, acknowledgements: 0}, sessionPresent: session.sessionPresent,
            afterRestart: {deliveries: receipts.length, acknowledgements: brokerAcks.length, readings: 3, rejected: 2},
            receipts};
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    if (client) await client.endAsync(true);
    if (publisher) await publisher.endAsync(true);
    inbox?.close();
    await new Promise(resolveClose => broker.close(resolveClose));
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(folder, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await exercise(), null, 2));
}
