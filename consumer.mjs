import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';
import { Inbox } from './inbox.mjs';

export function consumer(url, clientId, inbox) {
  const client = mqtt.connect(url, { clientId, clean: false, protocolVersion: 4, manualConnect: true,
    reconnectPeriod: 1000, resubscribe: false });
  client.handleMessage = (packet, done) => {
    let receipt;
    try {
      receipt = inbox.record(packet.topic, packet.payload);
    } catch (error) {
      client.stream.destroy();
      done(error);
      return;
    }
    client.emit('receipt', { ...receipt, messageId: packet.messageId, qos: packet.qos });
    done();
  };
  client.on('connect', ({ sessionPresent }) => {
    client.subscribe('coldroom/+/reading', { qos: 1 }, (error, granted) => {
      if (error || granted?.[0]?.qos !== 1) {
        client.emit('error', error ?? new Error('Broker did not grant QoS 1'));
        client.stream.destroy();
        return;
      }
      client.emit('subscribed', { sessionPresent });
    });
  });
  return client;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [url, id, database] = process.argv.slice(2);
  if (!url || !id || !database) {
    console.error('Usage: node consumer.mjs BROKER_URL STABLE_CLIENT_ID DATABASE');
    process.exitCode = 2;
  } else {
    const inbox = new Inbox(database);
    const client = consumer(url, id, inbox);
    for (const event of ['subscribed', 'receipt']) {
      client.on(event, data => console.log(JSON.stringify({ event, ...data })));
    }
    client.on('error', error => console.error(error.message));
    let stopping = false;
    async function stop() {
      if (stopping) return;
      stopping = true;
      try { await client.endAsync(); } finally { inbox.close(); }
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    client.connect();
  }
}
