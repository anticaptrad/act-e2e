// HTTP protocol semantics every service must get right.
//
// These pin behaviour that is easy to regress when routing or middleware
// changes: method handling, path matching, query strings, content-type
// enforcement, and body limits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services, timeoutMs } from '../config.mjs';
import { get, postJson } from '../helpers/http.mjs';

const ALL = Object.entries(services);

describe('method handling', () => {
  for (const [name, base] of ALL) {
    test(`${name}: HEAD /health succeeds with an empty body`, async () => {
      const res = await fetch(`${base}/health`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs),
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '', 'HEAD must not return a body');
    });

    test(`${name}: POST to a GET-only route is a client error`, async () => {
      // axum answers 405 and Fastify 404; both are correct refusals, so the
      // contract is "a 4xx that is not a success", not one exact code.
      const res = await fetch(`${base}/health`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      });
      assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    });

    test(`${name}: an unsupported method never 5xxs`, async () => {
      for (const method of ['DELETE', 'PUT', 'PATCH']) {
        const res = await fetch(`${base}/health`, {
          method,
          signal: AbortSignal.timeout(timeoutMs),
        });
        assert.ok(res.status < 500, `${method} produced ${res.status}`);
      }
    });
  }
});

describe('path matching', () => {
  for (const [name, base] of ALL) {
    test(`${name}: a trailing slash does not alias the route`, async () => {
      const { status } = await get(`${base}/health/`);
      assert.equal(status, 404);
    });

    test(`${name}: paths are case-sensitive`, async () => {
      const { status } = await get(`${base}/HEALTH`);
      assert.equal(status, 404);
    });

    test(`${name}: a query string is ignored on /health`, async () => {
      const { status, body } = await get(`${base}/health?cache=0&x=${Date.now()}`);
      assert.equal(status, 200);
      assert.match(body, /ok/i);
    });

    test(`${name}: a deep unknown path 404s rather than erroring`, async () => {
      const { status } = await get(`${base}/a/b/c/d/e/f/g`);
      assert.equal(status, 404);
    });

    test(`${name}: percent-encoded junk in the path is handled`, async () => {
      const { status } = await get(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
      assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
    });
  }
});

describe('content-type enforcement', () => {
  test('the MCP endpoint requires application/json', async () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await fetch(`${services.mcp}/mcp`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      assert.equal(res.status, 415, `${contentType} should be rejected`);
    }
  });

  test('the MCP endpoint rejects a body with no content-type', async () => {
    const res = await fetch(`${services.mcp}/mcp`, {
      method: 'POST',
      headers: { 'content-type': '' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
  });

  test('a JSON content-type with a charset parameter is accepted', async () => {
    const res = await fetch(`${services.mcp}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(res.status, 200);
  });
});

describe('request body limits', () => {
  /**
   * A server may refuse an oversized body either with a 4xx or by closing the
   * connection mid-upload — undici surfaces the latter as a transport error.
   * Both are valid refusals; being *accepted* is the failure we care about.
   */
  async function assertRefused(url, payload) {
    let status;
    try {
      ({ status } = await postJson(url, payload));
    } catch (err) {
      return; // connection-level refusal
    }
    assert.ok(status >= 400, `oversized body was accepted with ${status}`);
  }

  test('an oversized MCP body is refused, not accepted', async () => {
    await assertRefused(`${services.mcp}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { blob: 'x'.repeat(4_000_000) },
    });
  });

  test('an oversized AI body is refused, not accepted', async () => {
    await assertRefused(`${services.ai}/api/generate/script`, {
      topic: 'x'.repeat(4_000_000),
      provider: 'openai',
    });
  });

  test('the services stay healthy after an oversized body', async () => {
    for (const base of [services.mcp, services.ai]) {
      const { status } = await get(`${base}/health`);
      assert.equal(status, 200);
    }
  });

  test('an empty body on a JSON route is a client error', async () => {
    const res = await fetch(`${services.mcp}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  });
});

describe('connection handling', () => {
  test('many sequential requests reuse the connection without failing', async () => {
    for (let i = 0; i < 50; i++) {
      const { status } = await get(`${services.api}/health`);
      assert.equal(status, 200, `request ${i} failed`);
    }
  });

  test('mixed concurrent traffic across services all succeeds', async () => {
    const work = [];
    for (let i = 0; i < 10; i++) {
      work.push(get(`${services.api}/health`));
      work.push(get(`${services.web}/ready`));
      work.push(postJson(`${services.mcp}/mcp`, { jsonrpc: '2.0', id: i, method: 'ping' }));
      work.push(postJson(`${services.ai}/api/generate/video`, { script: 'x' }));
    }
    const results = await Promise.all(work);
    for (const { status } of results) {
      assert.ok(status < 400, `unexpected status ${status}`);
    }
  });
});
