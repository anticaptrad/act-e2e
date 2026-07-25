// NATS bridge integration.
//
// `act.events.>` is the subject the api-server subscribes to (see
// act-api-server.rs/src/nats.rs), so these tests exercise the same wildcard
// contract the service depends on: delivery, subject scoping, payload
// integrity, and request/reply.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, StringCodec, JSONCodec, headers as natsHeaders } from 'nats';
import { nats as natsConfig, timeoutMs } from '../config.mjs';

const sc = StringCodec();
const jc = JSONCodec();

// Test files run in parallel against one broker, so a bare `act.events.>`
// subscription would also see traffic published by the other NATS suites.
// Scoping every subject under a per-run token keeps the wildcard assertions
// about *this* file's traffic while still exercising the same match semantics
// the api-server relies on.
const RUN = `${process.pid}-${Date.now()}`;
const EVENTS = `act.events.${RUN}`;

let nc;

before(async () => {
  nc = await connect({ servers: natsConfig.url, timeout: timeoutMs });
});

after(async () => {
  if (nc) await nc.drain();
});

/** Collect up to `count` messages from a subscription. */
async function collect(sub, count) {
  const out = [];
  for await (const msg of sub) {
    out.push(msg);
    if (out.length >= count) break;
  }
  return out;
}

describe('connectivity', () => {
  test('the broker is reachable and reports a server identity', async () => {
    assert.ok(!nc.isClosed(), 'connection should be open');
    assert.ok(nc.info?.server_id, 'expected a server_id from the broker');
  });

  test('flush round-trips to the server', async () => {
    await nc.flush();
  });
});

describe('act.events delivery', () => {
  test('a published event round-trips through the bridge', async () => {
    const subject = `${EVENTS}.ping`;
    const sub = nc.subscribe(subject, { max: 1 });
    const received = collect(sub, 1);

    const payload = `e2e-${process.pid}-${Date.now()}`;
    nc.publish(subject, sc.encode(payload));
    await nc.flush();

    const [msg] = await received;
    assert.equal(sc.decode(msg.data), payload);
    assert.equal(msg.subject, subject);
  });

  test('the > wildcard matches arbitrarily deep subjects', async () => {
    const sub = nc.subscribe(`${EVENTS}.>`, { max: 3 });
    await nc.flush();
    const received = collect(sub, 3);

    const subjects = [
      `${EVENTS}.one`,
      `${EVENTS}.two.level`,
      `${EVENTS}.three.levels.deep`,
    ];
    for (const s of subjects) nc.publish(s, sc.encode(s));
    await nc.flush();

    const got = (await received).map((m) => m.subject).sort();
    assert.deepEqual(got, [...subjects].sort());
  });

  test('subjects outside act.events are not delivered to the bridge', async () => {
    const sub = nc.subscribe(`${EVENTS}.>`);
    await nc.flush();
    const seen = [];
    (async () => {
      for await (const m of sub) seen.push(m.subject);
    })();

    nc.publish('other.namespace.event', sc.encode('should-not-match'));
    nc.publish('act.commands.run', sc.encode('should-not-match'));
    nc.publish(`${EVENTS}.included`, sc.encode('should-match'));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 250));
    sub.unsubscribe();

    assert.deepEqual(seen, [`${EVENTS}.included`]);
  });

  test('a single-token wildcard does not cross token boundaries', async () => {
    const sub = nc.subscribe(`${EVENTS}.*`);
    await nc.flush();
    const seen = [];
    (async () => {
      for await (const m of sub) seen.push(m.subject);
    })();

    nc.publish(`${EVENTS}.flat`, sc.encode('x'));
    nc.publish(`${EVENTS}.nested.deeper`, sc.encode('x'));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 250));
    sub.unsubscribe();

    assert.deepEqual(seen, [`${EVENTS}.flat`]);
  });
});

describe('payload integrity', () => {
  test('JSON payloads survive the round trip', async () => {
    const subject = `${EVENTS}.json`;
    const sub = nc.subscribe(subject, { max: 1 });
    const received = collect(sub, 1);

    const payload = { id: 42, nested: { ok: true, list: [1, 2, 3] }, when: 'now' };
    nc.publish(subject, jc.encode(payload));
    await nc.flush();

    const [msg] = await received;
    assert.deepEqual(jc.decode(msg.data), payload);
  });

  test('unicode and control characters survive intact', async () => {
    const subject = `${EVENTS}.unicode`;
    const sub = nc.subscribe(subject, { max: 1 });
    const received = collect(sub, 1);

    const payload = 'héllo 🌍 — "quoted" \\ backslash \n newline \t tab';
    nc.publish(subject, sc.encode(payload));
    await nc.flush();

    const [msg] = await received;
    assert.equal(sc.decode(msg.data), payload);
  });

  test('an empty payload is delivered', async () => {
    const subject = `${EVENTS}.empty`;
    const sub = nc.subscribe(subject, { max: 1 });
    const received = collect(sub, 1);

    nc.publish(subject, new Uint8Array(0));
    await nc.flush();

    const [msg] = await received;
    assert.equal(msg.data.length, 0);
  });

  test('a large payload is delivered intact', async () => {
    const subject = `${EVENTS}.large`;
    const sub = nc.subscribe(subject, { max: 1 });
    const received = collect(sub, 1);

    const payload = 'x'.repeat(64 * 1024);
    nc.publish(subject, sc.encode(payload));
    await nc.flush();

    const [msg] = await received;
    assert.equal(sc.decode(msg.data).length, payload.length);
  });

  test('message headers survive the round trip', async () => {
    const subject = `${EVENTS}.headers`;
    const sub = nc.subscribe(subject, { max: 1 });
    const received = collect(sub, 1);

    const h = natsHeaders();
    h.set('X-Act-Trace-Id', 'trace-abc-123');
    nc.publish(subject, sc.encode('with-headers'), { headers: h });
    await nc.flush();

    const [msg] = await received;
    assert.equal(msg.headers?.get('X-Act-Trace-Id'), 'trace-abc-123');
  });
});

describe('ordering and throughput', () => {
  test('messages on one subject arrive in publish order', async () => {
    const subject = `${EVENTS}.ordered`;
    const sub = nc.subscribe(subject, { max: 25 });
    const received = collect(sub, 25);

    for (let i = 0; i < 25; i++) nc.publish(subject, sc.encode(String(i)));
    await nc.flush();

    const got = (await received).map((m) => Number(sc.decode(m.data)));
    assert.deepEqual(got, Array.from({ length: 25 }, (_, i) => i));
  });

  test('a burst of events is delivered without loss', async () => {
    const subject = `${EVENTS}.burst`;
    const count = 250;
    const sub = nc.subscribe(subject, { max: count });
    const received = collect(sub, count);

    for (let i = 0; i < count; i++) nc.publish(subject, sc.encode(String(i)));
    await nc.flush();

    assert.equal((await received).length, count);
  });

  test('multiple subscribers each receive a copy (fan-out)', async () => {
    const subject = `${EVENTS}.fanout`;
    const subA = nc.subscribe(subject, { max: 1 });
    const subB = nc.subscribe(subject, { max: 1 });
    const both = Promise.all([collect(subA, 1), collect(subB, 1)]);

    nc.publish(subject, sc.encode('broadcast'));
    await nc.flush();

    const [[a], [b]] = await both;
    assert.equal(sc.decode(a.data), 'broadcast');
    assert.equal(sc.decode(b.data), 'broadcast');
  });

  test('queue-group members share the load (no duplicate delivery)', async () => {
    const subject = `${EVENTS}.queue`;
    const queue = 'workers';
    const total = 20;
    let handled = 0;

    const subs = ['a', 'b'].map(() => nc.subscribe(subject, { queue }));
    for (const s of subs) {
      (async () => {
        for await (const _ of s) handled += 1;
      })();
    }

    for (let i = 0; i < total; i++) nc.publish(subject, sc.encode(String(i)));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 400));
    for (const s of subs) s.unsubscribe();

    assert.equal(handled, total, 'each message should be handled exactly once');
  });
});

describe('request/reply', () => {
  test('a responder can answer a request', async () => {
    const subject = `${EVENTS}.rpc`;
    const sub = nc.subscribe(subject, { max: 1 });
    (async () => {
      for await (const msg of sub) {
        msg.respond(sc.encode(`echo:${sc.decode(msg.data)}`));
      }
    })();

    const reply = await nc.request(subject, sc.encode('hello'), { timeout: 5000 });
    assert.equal(sc.decode(reply.data), 'echo:hello');
  });

  test('a request to an unanswered subject times out', async () => {
    await assert.rejects(
      () => nc.request(`${EVENTS}.nobody-home`, sc.encode('x'), { timeout: 500 }),
      'expected the request to time out',
    );
  });
});
