import { consumer } from '../consumer.mjs';
import { Inbox } from '../inbox.mjs';

const [url, id, database] = process.argv.slice(2);
const client = consumer(url, id, new Inbox(database));
client.on('error', error => console.error(error.message));
client.on('subscribed', () => process.send({ event: 'ready' }));
// Replace only the acknowledgement continuation. The regular handler still commits to SQLite.
const handle = client.handleMessage.bind(client);
client.handleMessage = (packet, done) => handle(packet, error => {
  if (error) return done(error);
  process.send({ event: 'committed', messageId: packet.messageId });
});
client.connect();
