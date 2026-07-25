// act-ai-server route contracts.
//
// Provider calls cost money and need credentials, so these tests exercise the
// request-validation and configuration-error paths rather than driving real
// model completions. Which providers are configured is read from /ready, so the
// suite adapts to whatever credentials the environment actually holds.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { getJson, postJson } from '../helpers/http.mjs';

const AI = services.ai;
const ALL_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok'];

let configured = [];
let unconfigured = [];

before(async () => {
  const { json } = await getJson(`${AI}/ready`);
  configured = json.providers ?? [];
  unconfigured = ALL_PROVIDERS.filter((p) => !configured.includes(p));
});

describe('POST /api/generate/script — validation', () => {
  const badRequests = [
    ['an empty body', {}],
    ['a missing provider', { topic: 'nix flakes' }],
    ['a missing topic', { provider: 'openai' }],
    ['an empty topic', { topic: '', provider: 'openai' }],
  ];

  for (const [label, payload] of badRequests) {
    test(`rejects ${label} with 400`, async () => {
      const { status, json } = await postJson(`${AI}/api/generate/script`, payload);
      assert.equal(status, 400);
      assert.ok(json.error, 'expected an error message');
    });
  }

  test('rejects an unknown provider with 400', async () => {
    const { status, json } = await postJson(`${AI}/api/generate/script`, {
      topic: 'nix flakes',
      provider: 'definitely-not-a-provider',
    });
    assert.equal(status, 400);
    assert.match(json.error, /unsupported provider/i);
  });

  test('provider names are case-sensitive', async () => {
    const { status } = await postJson(`${AI}/api/generate/script`, {
      topic: 'nix flakes',
      provider: 'OpenAI',
    });
    assert.equal(status, 400);
  });
});

describe('POST /api/generate/script — unconfigured providers', () => {
  test('returns 503 naming the missing environment variable', async (t) => {
    if (unconfigured.length === 0) {
      t.skip('every provider is configured in this environment');
      return;
    }
    for (const provider of unconfigured) {
      const { status, json } = await postJson(`${AI}/api/generate/script`, {
        topic: 'nix flakes',
        provider,
      });
      assert.equal(status, 503, `${provider} should report unavailable`);
      assert.match(json.error, /not configured/i);
      assert.match(json.error, /API_KEY/, 'error should name the missing env var');
    }
  });

  test('an unconfigured provider does not take the process down', async () => {
    // Regression guard: provider clients were once constructed at module load,
    // so a single missing key crash-looped the pod and killed the probes too.
    for (const provider of unconfigured) {
      await postJson(`${AI}/api/generate/script`, { topic: 't', provider });
    }
    const { status, json } = await getJson(`${AI}/health`);
    assert.equal(status, 200);
    assert.equal(json.status, 'ok');
  });
});

describe('POST /api/generate/video', () => {
  test('rejects a missing script with 400', async () => {
    const { status, json } = await postJson(`${AI}/api/generate/video`, {});
    assert.equal(status, 400);
    assert.match(json.error, /missing script/i);
  });

  test('rejects an empty script with 400', async () => {
    const { status } = await postJson(`${AI}/api/generate/video`, { script: '' });
    assert.equal(status, 400);
  });

  test('accepts a script and returns a video URL', async () => {
    const { status, json } = await postJson(`${AI}/api/generate/video`, {
      script: 'FADE IN. A terminal glows.',
    });
    assert.equal(status, 200);
    assert.equal(json.status, 'success');
    assert.match(json.videoUrl, /^https?:\/\//);
  });
});

describe('POST /api/publish/youtube — validation', () => {
  const badRequests = [
    ['an empty body', {}],
    ['a missing title', { filePath: '/tmp/x.mp4' }],
    ['a missing filePath', { title: 'My Video' }],
  ];

  for (const [label, payload] of badRequests) {
    test(`rejects ${label} with 400`, async () => {
      const { status, json } = await postJson(`${AI}/api/publish/youtube`, payload);
      assert.equal(status, 400);
      assert.ok(json.error);
    });
  }

  test('validation runs before any upload is attempted', async () => {
    // A 400 must come back promptly rather than after a network round trip to
    // YouTube, proving the guard short-circuits.
    const started = Date.now();
    const { status } = await postJson(`${AI}/api/publish/youtube`, {});
    assert.equal(status, 400);
    assert.ok(Date.now() - started < 2000, 'validation should short-circuit');
  });
});

describe('error responses are well formed', () => {
  test('every error body is JSON with an error field', async () => {
    const cases = [
      [`${AI}/api/generate/script`, {}],
      [`${AI}/api/generate/video`, {}],
      [`${AI}/api/publish/youtube`, {}],
    ];
    for (const [url, payload] of cases) {
      const { headers, json } = await postJson(url, payload);
      assert.match(headers.get('content-type') ?? '', /application\/json/);
      assert.equal(typeof json.error, 'string');
    }
  });

  test('GET on a POST-only route is not treated as success', async () => {
    const { status } = await getJson(`${AI}/api/generate/script`);
    assert.ok(status >= 400, `expected an error status, got ${status}`);
  });
});
