// Service contract sweep: every service must expose well-formed liveness and
// readiness probes, serve them without credentials, and 404 unknown routes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { get, getJson } from '../helpers/http.mjs';

describe('probe contracts', () => {
  for (const [name, base] of Object.entries(services)) {
    test(`${name}: /health reports ok`, async () => {
      const { status, json } = await getJson(`${base}/health`);
      assert.equal(status, 200);
      assert.ok(json, 'expected a JSON body');
      assert.equal(json.status, 'ok');
    });

    test(`${name}: /health is JSON`, async () => {
      const { headers } = await get(`${base}/health`);
      assert.match(headers.get('content-type') ?? '', /application\/json/);
    });

    test(`${name}: /ready reports ready`, async () => {
      const { status, json } = await getJson(`${base}/ready`);
      assert.equal(status, 200);
      assert.equal(json.ready, true);
    });

    test(`${name}: probes need no credentials`, async () => {
      // Probes must never sit behind auth — kubelet sends no Authorization header.
      for (const path of ['/health', '/ready']) {
        const { status } = await get(`${base}${path}`);
        assert.equal(status, 200, `${path} should be public`);
      }
    });

    test(`${name}: unknown route returns 404`, async () => {
      const { status } = await get(`${base}/definitely-not-a-real-route-e2e`);
      assert.equal(status, 404);
    });
  }
});

describe('readiness payloads expose dependency state', () => {
  test('api reports NATS connectivity', async () => {
    const { json } = await getJson(`${services.api}/ready`);
    assert.equal(typeof json.nats_connected, 'boolean');
  });

  test('web reports database connectivity', async () => {
    const { json } = await getJson(`${services.web}/ready`);
    assert.equal(typeof json.database_connected, 'boolean');
  });

  test('ai reports which providers are configured', async () => {
    const { json } = await getJson(`${services.ai}/ready`);
    assert.ok(Array.isArray(json.providers), 'providers should be an array');
    for (const p of json.providers) {
      assert.ok(
        ['openai', 'anthropic', 'gemini', 'grok'].includes(p),
        `unexpected provider: ${p}`,
      );
    }
  });

  test('readiness does not depend on optional dependencies', async () => {
    // NATS, Postgres, and LLM credentials are all optional at boot: the service
    // must still report ready so a dependency outage doesn't cascade.
    for (const base of [services.api, services.web, services.ai]) {
      const { json } = await getJson(`${base}/ready`);
      assert.equal(json.ready, true);
    }
  });
});

describe('resilience', () => {
  test('services handle concurrent probe load', async () => {
    const requests = Object.values(services).flatMap((base) =>
      Array.from({ length: 15 }, () => getJson(`${base}/health`)),
    );
    const results = await Promise.all(requests);
    assert.equal(results.length, Object.keys(services).length * 15);
    for (const { status } of results) assert.equal(status, 200);
  });

  test('repeated probes stay consistent', async () => {
    for (let i = 0; i < 5; i++) {
      const { status, json } = await getJson(`${services.api}/health`);
      assert.equal(status, 200);
      assert.equal(json.status, 'ok');
    }
  });
});
