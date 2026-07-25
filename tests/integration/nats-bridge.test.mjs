// NATS bridge integration: publish an event on act.events.> and confirm the
// bridge delivers it to a subscriber. This mirrors the subject the api-server
// subscribes to (see act-api-server.rs/src/nats.rs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, StringCodec } from 'nats';
import { nats as natsConfig, timeoutMs } from '../config.mjs';

let nc;
const sc = StringCodec();

before(async () => {
  nc = await connect({ servers: natsConfig.url, timeout: timeoutMs });
});

after(async () => {
  if (nc) await nc.drain();
});

test('event published to act.events.> round-trips through the bridge', async () => {
  const subject = 'act.events.e2e.ping';
  const sub = nc.subscribe(subject, { max: 1 });

  const received = (async () => {
    for await (const msg of sub) {
      return sc.decode(msg.data);
    }
    return null;
  })();

  const payload = `e2e-${process.pid}`;
  nc.publish(subject, sc.encode(payload));
  await nc.flush();

  const got = await received;
  assert.equal(got, payload);
});
