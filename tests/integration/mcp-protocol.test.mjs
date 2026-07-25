// MCP JSON-RPC 2.0 conformance for act-mcp-server.
//
// Covers the handshake, the tool primitives, JSON-RPC error codes, and the
// notification rule (a request without `id` gets no response body).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { postJson, rpc } from '../helpers/http.mjs';

const MCP = `${services.mcp}/mcp`;

// JSON-RPC standard error codes the server is expected to use.
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

describe('handshake', () => {
  test('initialize returns protocol version and server info', async () => {
    const { status, json } = await postJson(MCP, rpc('initialize', {}));
    assert.equal(status, 200);
    assert.equal(json.jsonrpc, '2.0');
    assert.equal(json.id, 1);
    assert.equal(json.result.protocolVersion, '2024-11-05');
    assert.equal(json.result.serverInfo.name, 'act-mcp-server');
    assert.ok(json.result.serverInfo.version, 'expected a server version');
  });

  test('initialize advertises tool capability', async () => {
    const { json } = await postJson(MCP, rpc('initialize', {}));
    assert.ok(json.result.capabilities.tools, 'expected tools capability');
  });

  test('ping returns an empty result', async () => {
    const { json } = await postJson(MCP, rpc('ping', undefined, 42));
    assert.equal(json.id, 42);
    assert.deepEqual(json.result, {});
  });
});

describe('tools', () => {
  test('tools/list returns the catalog', async () => {
    const { json } = await postJson(MCP, rpc('tools/list'));
    const tools = json.result.tools;
    assert.ok(Array.isArray(tools), 'tools should be an array');
    assert.ok(tools.length > 0, 'expected at least one tool');
  });

  test('every advertised tool has a name, description, and input schema', async () => {
    const { json } = await postJson(MCP, rpc('tools/list'));
    for (const tool of json.result.tools) {
      assert.ok(tool.name, 'tool needs a name');
      assert.ok(tool.description, `tool ${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  test('tools/call echoes the supplied message', async () => {
    const message = `e2e-${Date.now()}`;
    const { json } = await postJson(
      MCP,
      rpc('tools/call', { name: 'ping', arguments: { message } }),
    );
    assert.equal(json.result.isError, false);
    assert.deepEqual(json.result.content, [{ type: 'text', text: message }]);
  });

  test('tools/call falls back to a default when no message is given', async () => {
    const { json } = await postJson(MCP, rpc('tools/call', { name: 'ping', arguments: {} }));
    assert.equal(json.result.isError, false);
    assert.equal(json.result.content[0].text, 'pong');
  });

  test('tools/call works when arguments are omitted entirely', async () => {
    const { json } = await postJson(MCP, rpc('tools/call', { name: 'ping' }));
    assert.equal(json.result.isError, false);
  });

  test('every tool in the catalog is actually callable', async () => {
    const { json: list } = await postJson(MCP, rpc('tools/list'));
    for (const tool of list.result.tools) {
      const { json } = await postJson(MCP, rpc('tools/call', { name: tool.name, arguments: {} }));
      assert.ok(json.result, `tool ${tool.name} should return a result`);
      assert.ok(Array.isArray(json.result.content), `tool ${tool.name} should return content`);
    }
  });
});

describe('error handling', () => {
  test('unknown tool returns INVALID_PARAMS', async () => {
    const { json } = await postJson(MCP, rpc('tools/call', { name: 'no-such-tool' }));
    assert.equal(json.error.code, INVALID_PARAMS);
    assert.match(json.error.message, /unknown tool/i);
  });

  test('missing tool name returns INVALID_PARAMS', async () => {
    const { json } = await postJson(MCP, rpc('tools/call', {}));
    assert.equal(json.error.code, INVALID_PARAMS);
    assert.match(json.error.message, /missing tool name/i);
  });

  test('unknown method returns METHOD_NOT_FOUND', async () => {
    const { json } = await postJson(MCP, rpc('does/not/exist'));
    assert.equal(json.error.code, METHOD_NOT_FOUND);
  });

  test('an error response carries no result field', async () => {
    const { json } = await postJson(MCP, rpc('does/not/exist'));
    assert.equal(json.result, undefined);
    assert.ok(json.error);
  });

  test('malformed JSON is rejected with a 4xx', async () => {
    const { status } = await postJson(MCP, '{not valid json');
    assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
  });
});

describe('JSON-RPC envelope', () => {
  test('notifications (no id) get 202 and an empty body', async () => {
    const { status, body } = await postJson(MCP, rpc('ping', undefined, null));
    assert.equal(status, 202);
    assert.equal(body.trim(), '');
  });

  test('a notification for an unknown method is still silent', async () => {
    const { status, body } = await postJson(MCP, rpc('bogus/method', undefined, null));
    assert.equal(status, 202);
    assert.equal(body.trim(), '');
  });

  test('numeric and string ids are echoed unchanged', async () => {
    for (const id of [7, 'string-id-abc', 0]) {
      const { json } = await postJson(MCP, rpc('ping', undefined, id));
      assert.equal(json.id, id, `id ${JSON.stringify(id)} should round-trip`);
    }
  });

  test('every response declares jsonrpc 2.0', async () => {
    for (const req of [rpc('initialize', {}), rpc('tools/list'), rpc('nope')]) {
      const { json } = await postJson(MCP, req);
      assert.equal(json.jsonrpc, '2.0');
    }
  });

  test('concurrent requests each get their own id back', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 100);
    const responses = await Promise.all(
      ids.map((id) => postJson(MCP, rpc('ping', undefined, id))),
    );
    assert.deepEqual(responses.map((r) => r.json.id), ids);
  });
});
