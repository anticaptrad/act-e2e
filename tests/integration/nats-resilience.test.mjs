// NATS bridge resilience and lifecycle.
//
// nats-bridge.test.mjs covers the delivery contract; this file covers
// connection lifecycle, subscription management, and behaviour under load —
// the things that decide whether the event bus degrades gracefully.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, StringCodec } from 'nats';
import { nats as natsConfig, timeoutMs } from '../config.mjs';

const sc = StringCodec();
let nc;

before(async () => {
  nc = await connect({ servers: natsConfig.url, timeout: timeoutMs });
});

after(async () => {
  if (nc && !nc.isClosed()) await nc.drain();
});

const uniqueSubject = (name) => `act.events.e2e.${name}.${process.pid}.${Date.now()}`;

/**
 * Fail with a clear message instead of hanging when an expected message never
 * arrives. NATS core is fire-and-forget, so a lost message would otherwise
 * leave the collector awaiting forever.
 */
function withTimeout(promise, label, ms = 15_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms).unref(),
    ),
  ]);
}

/**
 * Register a subscription and wait for the server to acknowledge it.
 *
 * Subscribing is asynchronous: the SUB frame is queued on the connection. When
 * the publisher is a *different* connection there is no ordering guarantee
 * between our SUB and their PUB, so without this flush the first messages can
 * be delivered before the subscription exists and are silently dropped.
 */
async function subscribeAndFlush(subject, opts) {
  const sub = nc.subscribe(subject, opts);
  await nc.flush();
  return sub;
}

describe('connection lifecycle', () => {
  test('an independent connection can be opened and closed', async () => {
    const extra = await connect({ servers: natsConfig.url, timeout: timeoutMs });
    assert.ok(!extra.isClosed());
    await extra.close();
    assert.ok(extra.isClosed(), 'connection should report closed');
  });

  test('many concurrent connections are accepted', async () => {
    const conns = await Promise.all(
      Array.from({ length: 8 }, () => connect({ servers: natsConfig.url, timeout: timeoutMs })),
    );
    assert.equal(conns.length, 8);
    await Promise.all(conns.map((c) => c.close()));
  });

  test('closed returns once a connection is drained', async () => {
    const extra = await connect({ servers: natsConfig.url, timeout: timeoutMs });
    const closed = extra.closed();
    await extra.drain();
    await closed;
    assert.ok(extra.isClosed());
  });

  test('publishing from a second connection reaches the first', async () => {
    const subject = uniqueSubject('cross-conn');
    const sub = await subscribeAndFlush(subject, { max: 1 });
    const received = (async () => {
      for await (const m of sub) return sc.decode(m.data);
    })();

    const publisher = await connect({ servers: natsConfig.url, timeout: timeoutMs });
    publisher.publish(subject, sc.encode('from-other-connection'));
    await publisher.flush();
    await publisher.close();

    assert.equal(await withTimeout(received, 'cross-connection message'), 'from-other-connection');
  });
});

describe('subscription management', () => {
  test('unsubscribing stops delivery', async () => {
    const subject = uniqueSubject('unsub');
    const sub = nc.subscribe(subject);
    const seen = [];
    (async () => {
      for await (const m of sub) seen.push(sc.decode(m.data));
    })();

    nc.publish(subject, sc.encode('first'));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 200));

    sub.unsubscribe();
    nc.publish(subject, sc.encode('second'));
    await nc.flush();
    await new Promise((r) => setTimeout(r, 200));

    assert.deepEqual(seen, ['first'], 'no message should arrive after unsubscribe');
  });

  test('a max-limited subscription auto-unsubscribes', async () => {
    const subject = uniqueSubject('maxed');
    const sub = nc.subscribe(subject, { max: 2 });
    const seen = [];
    const done = (async () => {
      for await (const m of sub) seen.push(sc.decode(m.data));
    })();

    for (const v of ['a', 'b', 'c', 'd']) nc.publish(subject, sc.encode(v));
    await nc.flush();
    await done;

    assert.deepEqual(seen, ['a', 'b'], 'delivery should stop at the max');
  });

  test('many simultaneous subscriptions each receive their own subject', async () => {
    const subjects = Array.from({ length: 12 }, (_, i) => uniqueSubject(`multi-${i}`));
    const waits = subjects.map((s) => {
      const sub = nc.subscribe(s, { max: 1 });
      return (async () => {
        for await (const m of sub) return sc.decode(m.data);
      })();
    });

    subjects.forEach((s, i) => nc.publish(s, sc.encode(`payload-${i}`)));
    await nc.flush();

    const got = await withTimeout(Promise.all(waits), 'per-subject messages');
    assert.deepEqual(got, subjects.map((_, i) => `payload-${i}`));
  });

  test('subscription counts are reported', async () => {
    const subject = uniqueSubject('counted');
    const sub = nc.subscribe(subject, { max: 3 });
    for (let i = 0; i < 3; i++) nc.publish(subject, sc.encode(String(i)));
    await nc.flush();
    for await (const _ of sub) if (sub.getProcessed() >= 3) break;
    assert.equal(sub.getProcessed(), 3);
  });
});

describe('load behaviour', () => {
  test('a high-volume burst is delivered without loss', async () => {
    const subject = uniqueSubject('volume');
    const count = 2000;
    const sub = nc.subscribe(subject, { max: count });
    const done = (async () => {
      let n = 0;
      for await (const _ of sub) if (++n >= count) break;
      return n;
    })();

    for (let i = 0; i < count; i++) nc.publish(subject, sc.encode(String(i)));
    await nc.flush();

    assert.equal(await withTimeout(done, `${count} burst messages`), count);
  });

  test('interleaved subjects stay correctly routed under load', async () => {
    const a = uniqueSubject('interleave-a');
    const b = uniqueSubject('interleave-b');
    const subA = nc.subscribe(a, { max: 100 });
    const subB = nc.subscribe(b, { max: 100 });

    const collect = async (sub, n) => {
      const out = [];
      for await (const m of sub) {
        out.push(sc.decode(m.data));
        if (out.length >= n) break;
      }
      return out;
    };
    const both = Promise.all([collect(subA, 100), collect(subB, 100)]);

    for (let i = 0; i < 100; i++) {
      nc.publish(a, sc.encode(`a${i}`));
      nc.publish(b, sc.encode(`b${i}`));
    }
    await nc.flush();

    const [gotA, gotB] = await withTimeout(both, 'interleaved subjects');
    assert.ok(gotA.every((v) => v.startsWith('a')), 'subject A received foreign messages');
    assert.ok(gotB.every((v) => v.startsWith('b')), 'subject B received foreign messages');
  });

  test('concurrent publishers all land on one subscriber', async () => {
    const subject = uniqueSubject('multi-pub');
    const publishers = await Promise.all(
      Array.from({ length: 4 }, () => connect({ servers: natsConfig.url, timeout: timeoutMs })),
    );
    const perPublisher = 50;
    const total = publishers.length * perPublisher;

    // Flush the subscription before the other connections start publishing;
    // cross-connection ordering is not guaranteed.
    const sub = await subscribeAndFlush(subject, { max: total });
    const done = (async () => {
      let n = 0;
      for await (const _ of sub) if (++n >= total) break;
      return n;
    })();

    await Promise.all(
      publishers.map(async (p, idx) => {
        for (let i = 0; i < perPublisher; i++) p.publish(subject, sc.encode(`${idx}-${i}`));
        await p.flush();
      }),
    );

    assert.equal(await withTimeout(done, `${total} messages from 4 publishers`), total);
    await Promise.all(publishers.map((p) => p.close()));
  });

  test('the connection stays usable after heavy traffic', async () => {
    const subject = uniqueSubject('after-load');
    const sub = nc.subscribe(subject, { max: 1 });
    const received = (async () => {
      for await (const m of sub) return sc.decode(m.data);
    })();
    nc.publish(subject, sc.encode('still-alive'));
    await nc.flush();
    assert.equal(await withTimeout(received, 'post-load message'), 'still-alive');
  });
});
