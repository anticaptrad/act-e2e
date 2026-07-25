// MCP transport and envelope edge cases.
//
// The conformance basics live in mcp-protocol.test.mjs; this file pins the
// awkward corners — wrong methods, wrong shapes, hostile sizes, and the exact
// treatment of `id: null`, which JSON-RPC defines as a notification.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services, timeoutMs } from '../config.mjs';
import { get, postJson } from '../helpers/http.mjs';

const MCP = `${services.mcp}/mcp`;
const INVALID_PARAMS = -32602;

describe('transport', () => {
  test('GET on the MCP endpoint is rejected', async () => {
    const { status } = await get(MCP);
    assert.equal(status, 405);
  });

  test('the endpoint is not exposed under another path', async () => {
    for (const path of ['/mcp/', '/MCP', '/rpc', '/jsonrpc']) {
      const res = await fetch(`${services.mcp}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      assert.ok(res.status >= 400, `${path} unexpectedly served MCP`);
    }
  });
});

describe('envelope shapes', () => {
  test('id: null is treated as a notification', async () => {
    // JSON-RPC 2.0 distinguishes a request (has an id) from a notification. An
    // explicit null id carries no way to correlate a reply, so no body is sent.
    const { status, body } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: null,
      method: 'ping',
    });
    assert.equal(status, 202);
    assert.equal(body.trim(), '');
  });

  test('a missing jsonrpc field is tolerated', async () => {
    const { status, json } = await postJson(MCP, { id: 1, method: 'ping' });
    assert.equal(status, 200);
    assert.deepEqual(json.result, {});
  });

  test('unknown top-level fields are ignored', async () => {
    const { status, json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      extra: 'ignored',
      metadata: { a: 1 },
    });
    assert.equal(status, 200);
    assert.equal(json.id, 1);
  });

  test('a non-string method is a deserialization error', async () => {
    const { status } = await postJson(MCP, { jsonrpc: '2.0', id: 1, method: 123 });
    assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
  });

  test('a missing method is a deserialization error', async () => {
    const { status } = await postJson(MCP, { jsonrpc: '2.0', id: 1 });
    assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
  });

  test('params of the wrong type degrade to an INVALID_PARAMS error', async () => {
    // `params` is schema-free at the transport level, so an array reaches the
    // handler and fails the tool lookup rather than the JSON decode.
    const { status, json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: [1, 2, 3],
    });
    assert.equal(status, 200);
    assert.equal(json.error.code, INVALID_PARAMS);
  });

  test('a JSON array body is rejected rather than half-processed', async () => {
    const { status } = await postJson(MCP, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
  });
});

describe('tool argument handling', () => {
  test('a long message round-trips intact', async () => {
    const message = 'x'.repeat(20_000);
    const { json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ping', arguments: { message } },
    });
    assert.equal(json.result.content[0].text.length, message.length);
  });

  test('unicode and emoji survive the round trip', async () => {
    const message = 'héllo 🌍 日本語 — ünïcode';
    const { json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ping', arguments: { message } },
    });
    assert.equal(json.result.content[0].text, message);
  });

  test('a non-string message is ignored in favour of the default', async () => {
    const { json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ping', arguments: { message: 12345 } },
    });
    assert.equal(json.result.content[0].text, 'pong');
  });

  test('an unexpected extra argument does not break the call', async () => {
    const { json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ping', arguments: { message: 'hi', unexpected: true } },
    });
    assert.equal(json.result.content[0].text, 'hi');
  });

  test('a tool name of the wrong type is an INVALID_PARAMS error', async () => {
    const { json } = await postJson(MCP, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 99 },
    });
    assert.equal(json.error.code, INVALID_PARAMS);
  });
});

describe('method name matching', () => {
  test('method names are case-sensitive', async () => {
    for (const method of ['Initialize', 'TOOLS/LIST', 'Ping']) {
      const { json } = await postJson(MCP, { jsonrpc: '2.0', id: 1, method });
      assert.ok(json.error, `${method} should not have matched`);
    }
  });

  test('whitespace around a method name is not trimmed away', async () => {
    const { json } = await postJson(MCP, { jsonrpc: '2.0', id: 1, method: ' ping ' });
    assert.ok(json.error, 'padded method should not match');
  });

  test('an empty method name is an error, not a default', async () => {
    const { json } = await postJson(MCP, { jsonrpc: '2.0', id: 1, method: '' });
    assert.ok(json.error);
  });
});

describe('sustained use', () => {
  test('the server stays correct under a burst of mixed calls', async () => {
    const work = [];
    for (let i = 0; i < 40; i++) {
      const method = ['ping', 'tools/list', 'initialize'][i % 3];
      work.push(postJson(MCP, { jsonrpc: '2.0', id: i, method, params: {} }));
    }
    const results = await Promise.all(work);
    results.forEach(({ status, json }, i) => {
      assert.equal(status, 200, `call ${i} failed`);
      assert.equal(json.id, i, `call ${i} returned the wrong id`);
      assert.ok(json.result, `call ${i} returned no result`);
    });
  });

  test('the server is still healthy after hostile input', async () => {
    const { status } = await get(`${services.mcp}/health`);
    assert.equal(status, 200);
  });
});
