// Direct HTTP health/readiness sweep across every AntiCapTrad service, using
// Node's built-in fetch (no browser driver needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { services, timeoutMs } from '../config.mjs';

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, body };
}

for (const [name, base] of Object.entries(services)) {
  test(`${name} service /health is OK`, async () => {
    const { status, body } = await get(`${base}/health`);
    assert.ok(status < 400, `expected < 400, got ${status}`);
    assert.match(body, /ok/i);
  });

  test(`${name} service /ready is OK`, async () => {
    const { status } = await get(`${base}/ready`);
    assert.ok(status < 400, `expected < 400, got ${status}`);
  });
}

test('mcp server responds to a JSON-RPC initialize', async () => {
  const res = await fetch(`${services.mcp}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.ok(res.ok, `expected 2xx, got ${res.status}`);
  const json = await res.json();
  assert.equal(json.result.protocolVersion, '2024-11-05');
});
