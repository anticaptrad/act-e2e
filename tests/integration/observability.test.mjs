// Observability plumbing.
//
// Every service initializes OpenTelemetry and sits behind a mesh/collector that
// injects W3C trace context. These tests assert the services accept that
// context — well-formed or not — without altering their behaviour, so tracing
// can be switched on in the cluster without risking request handling.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { get, getJson, postJson } from '../helpers/http.mjs';

const ALL = Object.entries(services);

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('W3C trace context is accepted', () => {
  test('a valid traceparent does not change the response', async () => {
    for (const [name, base] of ALL) {
      const plain = await getJson(`${base}/health`);
      const traced = await getJson(`${base}/health`, { headers: { traceparent: TRACEPARENT } });
      assert.equal(traced.status, 200, `${name} rejected a traceparent`);
      assert.deepEqual(traced.json, plain.json, `${name} changed output when traced`);
    }
  });

  test('traceparent plus tracestate is accepted', async () => {
    for (const [name, base] of ALL) {
      const { status } = await get(`${base}/health`, {
        headers: { traceparent: TRACEPARENT, tracestate: 'vendor=abc123,other=xyz' },
      });
      assert.equal(status, 200, `${name} rejected tracestate`);
    }
  });

  test('a malformed traceparent is tolerated rather than fatal', async () => {
    // A broken header from a misconfigured upstream must never turn into a 5xx.
    for (const [name, base] of ALL) {
      for (const bad of ['garbage', '00-tooshort-01', '']) {
        const { status } = await get(`${base}/health`, { headers: { traceparent: bad } });
        assert.ok(status < 500, `${name} returned ${status} for traceparent "${bad}"`);
      }
    }
  });

  test('trace context flows through a POST route', async () => {
    const { status, json } = await postJson(
      `${services.mcp}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { headers: { traceparent: TRACEPARENT } },
    );
    assert.equal(status, 200);
    assert.deepEqual(json.result, {});
  });
});

describe('correlation headers', () => {
  test('common correlation headers are accepted', async () => {
    const headers = {
      'x-request-id': 'e2e-req-0001',
      'x-correlation-id': 'e2e-corr-0001',
      'x-b3-traceid': '80f198ee56343ba864fe8b2a57d3eff7',
    };
    for (const [name, base] of ALL) {
      const { status } = await get(`${base}/health`, { headers });
      assert.equal(status, 200, `${name} rejected correlation headers`);
    }
  });

  test('an unusual but legal header set is accepted', async () => {
    const headers = {};
    for (let i = 0; i < 30; i++) headers[`x-custom-${i}`] = `value-${i}`;
    const { status } = await get(`${services.api}/health`, { headers });
    assert.equal(status, 200);
  });
});

describe('service identity', () => {
  test('readiness distinguishes the services from one another', async () => {
    // Each service exposes a different dependency surface, which is what lets
    // an operator tell them apart from probe output alone.
    const shapes = new Map();
    for (const [name, base] of ALL) {
      const { json } = await getJson(`${base}/ready`);
      shapes.set(name, Object.keys(json).sort().join(','));
    }
    assert.notEqual(shapes.get('api'), shapes.get('web'), 'api and web look identical');
    assert.notEqual(shapes.get('ai'), shapes.get('mcp'), 'ai and mcp look identical');
  });

  test('the MCP server identifies itself in its handshake', async () => {
    const { json } = await postJson(`${services.mcp}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    assert.equal(json.result.serverInfo.name, 'act-mcp-server');
    assert.match(json.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  });
});
