// Shared-secret auth on the protected surfaces.
//
// Two of this platform's endpoints are not ordinary reads:
//
//   - `/api/generate/script` spends money on every call. Unauthenticated, any
//     caller that can reach the pod can burn the whole LLM budget.
//   - `/api/publish/youtube` publishes to the project's real channel.
//   - `/mcp` is tool execution.
//
// These assert the gate is actually closed, and that it fails closed rather
// than open when no secret is configured.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services, serverAuth, timeoutMs } from '../config.mjs';

const skip = serverAuth.secret ? false : 'ACT_SERVER_AUTH_SECRET not set';

/** Raw call with explicit control over the auth header. */
async function call(url, { secret, method = 'POST', body = {} } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (secret !== undefined) headers['x-server-auth'] = secret;

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

/** Protected endpoints, with a payload that would otherwise be valid. */
const PROTECTED = [
  ['ai: generate script', `${services.ai}/api/generate/script`, { topic: 'x', provider: 'openai' }],
  ['ai: generate video', `${services.ai}/api/generate/video`, { script: 'x' }],
  ['ai: publish youtube', `${services.ai}/api/publish/youtube`, { filePath: 'a.mp4', title: 't' }],
  ['mcp: tools/list', `${services.mcp}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
];

describe('protected endpoints reject missing credentials', { skip }, () => {
  for (const [label, url, payload] of PROTECTED) {
    test(`${label}: no header is refused`, async () => {
      const { status } = await call(url, { body: payload });
      assert.ok(status === 401 || status === 503, `expected 401/503, got ${status}`);
    });

    test(`${label}: a wrong secret is refused`, async () => {
      const { status } = await call(url, { secret: 'not-the-secret', body: payload });
      assert.equal(status, 401);
    });

    test(`${label}: an empty secret is refused`, async () => {
      const { status } = await call(url, { secret: '', body: payload });
      assert.equal(status, 401);
    });

    test(`${label}: the correct secret gets past the gate`, async () => {
      const { status, body } = await call(url, { secret: serverAuth.secret, body: payload });
      assert.notEqual(status, 401, 'valid credentials were refused');
      // A 503 past the gate is legitimate — an unconfigured LLM provider or
      // YouTube answers that way. Only an *auth* 503 is a failure here, so
      // distinguish them by message rather than by status alone.
      if (status === 503) {
        assert.ok(
          !/server auth is not configured/i.test(body),
          `request was refused by the auth gate: ${body.slice(0, 160)}`,
        );
      }
    });

    test(`${label}: a refusal never echoes the expected secret`, async () => {
      const { body } = await call(url, { secret: 'wrong', body: payload });
      assert.ok(!body.includes(serverAuth.secret), 'response leaked the expected secret');
    });
  }
});

describe('the money and publishing routes are closed by default', { skip }, () => {
  test('an unauthenticated caller cannot reach a paid provider', async () => {
    // The failure that matters is a 200 or a 503-from-the-provider: either
    // would mean the request got past the gate and into billable code.
    const { status } = await call(`${services.ai}/api/generate/script`, {
      body: { topic: 'expensive', provider: 'openai' },
    });
    assert.equal(status, 401, 'an unauthenticated call reached the provider path');
  });

  test('an unauthenticated caller cannot publish', async () => {
    const { status, body } = await call(`${services.ai}/api/publish/youtube`, {
      body: { filePath: 'render.mp4', title: 'unauthorized upload' },
    });
    assert.equal(status, 401);
    assert.ok(!body.includes('videoId'), 'an unauthenticated call produced an upload');
  });

  test('an unauthenticated caller cannot execute MCP tools', async () => {
    const { status } = await call(`${services.mcp}/mcp`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping' } },
    });
    assert.equal(status, 401);
  });
});

describe('probes stay public', { skip }, () => {
  test('health and readiness need no credentials', async () => {
    // The kubelet sends no headers; gating probes would make the pod
    // permanently unready.
    for (const base of [services.ai, services.mcp]) {
      for (const path of ['/health', '/ready']) {
        const { status } = await call(`${base}${path}`, { method: 'GET' });
        assert.equal(status, 200, `${base}${path} required credentials`);
      }
    }
  });

  test('a garbage credential does not break the probes', async () => {
    const { status } = await call(`${services.ai}/health`, { method: 'GET', secret: 'garbage' });
    assert.equal(status, 200);
  });
});

describe('auth configuration is observable', { skip }, () => {
  test('readiness reports whether auth is configured', async () => {
    const res = await fetch(`${services.ai}/ready`, { signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json();
    assert.equal(json.auth, 'configured');
  });

  test('readiness never leaks the secret itself', async () => {
    const { body } = await call(`${services.ai}/ready`, { method: 'GET' });
    assert.ok(!body.includes(serverAuth.secret), 'readiness leaked the shared secret');
  });
});
