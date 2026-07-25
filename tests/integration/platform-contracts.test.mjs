// Cross-service contracts.
//
// The platform runs two stacks (Rust/axum and Node/Fastify). These tests assert
// the conventions that must hold across *both*, so a new service or a rewrite
// cannot silently diverge from the shape the cluster and the clients expect.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { get, getJson } from '../helpers/http.mjs';

const ALL = Object.entries(services);

describe('every service speaks the same probe dialect', () => {
  test('/health returns exactly {"status":"ok"}', async () => {
    for (const [name, base] of ALL) {
      const { json } = await getJson(`${base}/health`);
      assert.deepEqual(json, { status: 'ok' }, `${name} deviates from the health contract`);
    }
  });

  test('/ready always includes a boolean `ready` field', async () => {
    for (const [name, base] of ALL) {
      const { json } = await getJson(`${base}/ready`);
      assert.equal(typeof json.ready, 'boolean', `${name} has no boolean ready field`);
    }
  });

  test('probes are JSON on every service', async () => {
    for (const [name, base] of ALL) {
      for (const path of ['/health', '/ready']) {
        const { headers } = await get(`${base}${path}`);
        assert.match(
          headers.get('content-type') ?? '',
          /application\/json/,
          `${name}${path} is not JSON`,
        );
      }
    }
  });

  test('probes respond without a request body or headers', async () => {
    for (const [name, base] of ALL) {
      const { status } = await get(`${base}/health`);
      assert.equal(status, 200, `${name} requires something extra to answer /health`);
    }
  });
});

describe('every service handles the unknown uniformly', () => {
  test('an unknown path is 404 everywhere', async () => {
    for (const [name, base] of ALL) {
      const { status } = await get(`${base}/__does_not_exist__`);
      assert.equal(status, 404, `${name} returned ${status}`);
    }
  });

  test('no service 5xxs on ordinary malformed input', async () => {
    for (const [name, base] of ALL) {
      for (const path of ['/health%', '/health?a=%zz', '/health#frag']) {
        const { status } = await get(`${base}${path}`);
        assert.ok(status < 500, `${name}${path} returned ${status}`);
      }
    }
  });
});

describe('readiness is advisory, never a hard gate', () => {
  test('services report ready even with optional dependencies missing', async () => {
    // A missing database, event bus, or LLM credential must not flip readiness
    // false — that would make k8s pull the pod out of service for a dependency
    // outage it can still partially serve through.
    for (const [name, base] of ALL) {
      const { json } = await getJson(`${base}/ready`);
      assert.equal(json.ready, true, `${name} is gating readiness on a dependency`);
    }
  });

  test('dependency state is surfaced for observability', async () => {
    const { json: api } = await getJson(`${services.api}/ready`);
    const { json: web } = await getJson(`${services.web}/ready`);
    const { json: ai } = await getJson(`${services.ai}/ready`);
    assert.ok('nats_connected' in api, 'api should surface NATS state');
    assert.ok('database_connected' in web, 'web should surface database state');
    assert.ok('providers' in ai, 'ai should surface configured providers');
  });
});

describe('probe responses are stable', () => {
  test('repeated /health calls are byte-identical', async () => {
    for (const [name, base] of ALL) {
      const first = (await get(`${base}/health`)).body;
      const second = (await get(`${base}/health`)).body;
      assert.equal(first, second, `${name} health output is not deterministic`);
    }
  });

  test('probes are side-effect free', async () => {
    // Hitting readiness repeatedly must not change what it reports.
    const before = (await getJson(`${services.api}/ready`)).json;
    for (let i = 0; i < 20; i++) await get(`${services.api}/ready`);
    const after = (await getJson(`${services.api}/ready`)).json;
    assert.deepEqual(after, before);
  });
});
