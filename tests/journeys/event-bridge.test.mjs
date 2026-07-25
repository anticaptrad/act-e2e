// End-to-end journey: an event published to NATS is consumed by act-api-server.
//
// The NATS suites prove the broker delivers to *our* subscriber. That is not
// the same claim as "the service consumes the events it subscribes to" — the
// bridge could be misconfigured, subscribed to the wrong subject, or silently
// failing, and every other test would still pass.
//
// Here the service is started under test ownership so its own log is the
// evidence that the message arrived.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, StringCodec } from 'nats';
import { nats as natsConfig, timeoutMs } from '../config.mjs';
import { skipUnlessBuilt, startService } from '../helpers/spawn.mjs';

const sc = StringCodec();
const RUN = `${process.pid}-${Date.now()}`;

/** Skip unless the api-server is built and a broker is reachable. */
async function reason() {
  const notBuilt = skipUnlessBuilt('api');
  if (notBuilt) return notBuilt;
  try {
    const probe = await connect({ servers: natsConfig.url, timeout: 3000 });
    await probe.close();
    return false;
  } catch {
    return `no NATS broker at ${natsConfig.url}`;
  }
}

const skip = (await reason()) || false;

let nc;
let api;

before(async () => {
  if (skip) return;
  nc = await connect({ servers: natsConfig.url, timeout: timeoutMs });
  api = await startService('api', { NATS_URL: natsConfig.url });
  // The service subscribes during startup; give the SUB a moment to register
  // before publishing, since cross-connection ordering is not guaranteed.
  await nc.flush();
  await new Promise((r) => setTimeout(r, 300));
}, { timeout: 60_000 });

after(async () => {
  if (api) await api.stop().catch(() => api.proc.kill('SIGKILL'));
  if (nc) await nc.drain();
});

/** Publish and wait for the service log to show it consumed the subject. */
async function publishAndAwaitConsumption(subject, payload, timeout = 10_000) {
  nc.publish(subject, sc.encode(payload));
  await nc.flush();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (api.logText().includes(subject)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('the service subscribes on startup', { skip }, () => {
  test('it reports a connection to the broker', () => {
    assert.match(api.logText(), /connected to NATS/i);
  });

  test('it subscribes to the platform event subject', () => {
    assert.match(api.logText(), /subscribed to event bus/i);
    assert.match(api.logText(), /act\.events\.>/);
  });

  test('readiness reflects the live connection', async () => {
    const res = await fetch(`${api.url}/ready`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    assert.equal(body.nats_connected, true);
  });
});

describe('published events reach the service', { skip }, () => {
  test('an event on act.events is consumed', async () => {
    const subject = `act.events.${RUN}.journey`;
    assert.ok(
      await publishAndAwaitConsumption(subject, 'journey-payload'),
      `service never logged consuming ${subject}`,
    );
  });

  test('the logged byte count matches the payload', async () => {
    const subject = `act.events.${RUN}.sized`;
    const payload = 'x'.repeat(321);
    assert.ok(await publishAndAwaitConsumption(subject, payload));
    // The bridge logs the payload size; a mismatch would mean truncation.
    assert.match(api.logText(), new RegExp(`${subject}[\\s\\S]{0,120}?bytes[^0-9]*321`));
  });

  test('deeply nested subjects are consumed by the wildcard', async () => {
    const subject = `act.events.${RUN}.deeply.nested.subject`;
    assert.ok(await publishAndAwaitConsumption(subject, 'deep'));
  });

  test('a burst of events is all consumed', async () => {
    const subjects = Array.from({ length: 15 }, (_, i) => `act.events.${RUN}.burst.${i}`);
    for (const s of subjects) nc.publish(s, sc.encode(s));
    await nc.flush();

    const deadline = Date.now() + 15_000;
    let missing = subjects;
    while (Date.now() < deadline && missing.length > 0) {
      const log = api.logText();
      missing = missing.filter((s) => !log.includes(s));
      if (missing.length) await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(missing, [], 'some events were never consumed');
  });

  test('a unicode payload is consumed without error', async () => {
    const subject = `act.events.${RUN}.unicode`;
    assert.ok(await publishAndAwaitConsumption(subject, 'héllo 🌍 日本語'));
  });
});

describe('subjects outside the subscription are ignored', { skip }, () => {
  test('an unrelated namespace is not consumed', async () => {
    const ignored = `other.namespace.${RUN}.ignored`;
    nc.publish(ignored, sc.encode('should not appear'));
    // Publish a subscribed subject afterwards as a synchronisation point: once
    // it shows up, anything published before it would have too.
    const marker = `act.events.${RUN}.marker`;
    assert.ok(await publishAndAwaitConsumption(marker, 'marker'));
    assert.ok(!api.logText().includes(ignored), 'service consumed an unsubscribed subject');
  });

  test('a sibling act namespace is not consumed', async () => {
    const ignored = `act.commands.${RUN}.run`;
    nc.publish(ignored, sc.encode('should not appear'));
    const marker = `act.events.${RUN}.marker2`;
    assert.ok(await publishAndAwaitConsumption(marker, 'marker2'));
    assert.ok(!api.logText().includes(ignored), 'service consumed act.commands');
  });
});

describe('the service survives event traffic', { skip }, () => {
  test('it stays healthy after consuming', async () => {
    const res = await fetch(`${api.url}/health`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200);
  });

  test('it still serves HTTP while consuming a burst', async () => {
    for (let i = 0; i < 50; i++) nc.publish(`act.events.${RUN}.load.${i}`, sc.encode('x'));
    await nc.flush();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${api.url}/health`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status),
      ),
    );
    assert.deepEqual(results, Array(10).fill(200));
  });

  test('it shuts down cleanly with an active subscription', async () => {
    const svc = await startService('api', { NATS_URL: natsConfig.url });
    const exit = await svc.stop('SIGTERM');
    assert.equal(exit.code, 0);
  });
});
