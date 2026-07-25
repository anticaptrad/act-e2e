// act-ai-server provider matrix.
//
// Exercises every provider the service claims to support, without spending
// money: which providers hold credentials is read from /ready, so a configured
// provider is only checked for "not a configuration error" while an
// unconfigured one must produce a precise, actionable 503.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { getJson, postJson } from '../helpers/http.mjs';

const AI = services.ai;
const SCRIPT = `${AI}/api/generate/script`;
const ALL_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok'];

let configured = [];
let unconfigured = [];

before(async () => {
  const { json } = await getJson(`${AI}/ready`);
  configured = json.providers ?? [];
  unconfigured = ALL_PROVIDERS.filter((p) => !configured.includes(p));
});

describe('provider enumeration', () => {
  test('/ready reports only recognised provider names', async () => {
    const { json } = await getJson(`${AI}/ready`);
    for (const p of json.providers ?? []) {
      assert.ok(ALL_PROVIDERS.includes(p), `unrecognised provider: ${p}`);
    }
  });

  test('every provider is either configured or reports as unconfigured', async () => {
    for (const provider of ALL_PROVIDERS) {
      const { status } = await postJson(SCRIPT, { topic: 'test', provider });
      if (configured.includes(provider)) {
        assert.notEqual(status, 503, `${provider} is configured but reported unavailable`);
      } else {
        assert.equal(status, 503, `${provider} is unconfigured but did not report 503`);
      }
    }
  });

  test('an unconfigured provider names its own environment variable', async (t) => {
    if (unconfigured.length === 0) return t.skip('all providers configured');
    const expected = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY',
      grok: 'XAI_API_KEY',
    };
    for (const provider of unconfigured) {
      const { json } = await postJson(SCRIPT, { topic: 'test', provider });
      assert.match(
        json.error,
        new RegExp(expected[provider]),
        `${provider} should name ${expected[provider]}`,
      );
    }
  });

  test('the error names the provider that failed', async (t) => {
    if (unconfigured.length === 0) return t.skip('all providers configured');
    for (const provider of unconfigured) {
      const { json } = await postJson(SCRIPT, { topic: 'test', provider });
      assert.match(json.error, new RegExp(provider), `error should name ${provider}`);
    }
  });
});

describe('input handling', () => {
  const provider = 'openai';

  test('a unicode topic is accepted by validation', async () => {
    const { status } = await postJson(SCRIPT, { topic: '日本語のトピック 🌍', provider });
    assert.notEqual(status, 400, 'unicode should pass validation');
  });

  test('a very long topic passes validation', async () => {
    const { status } = await postJson(SCRIPT, { topic: 'nix '.repeat(2000), provider });
    assert.notEqual(status, 400);
  });

  test('a whitespace-only topic is rejected before any provider call', async () => {
    // Whitespace passes a plain truthiness check, so without an explicit blank
    // check this would reach the provider and bill a request for empty input.
    const { status, json } = await postJson(SCRIPT, { topic: '   \n\t ', provider });
    assert.equal(status, 400);
    assert.match(json.error, /missing topic/i);
  });

  test('a whitespace-only script is rejected', async () => {
    const { status } = await postJson(`${AI}/api/generate/video`, { script: '   ' });
    assert.equal(status, 400);
  });

  test('a whitespace-only title is rejected', async () => {
    const { status } = await postJson(`${AI}/api/publish/youtube`, {
      filePath: '/tmp/x.mp4',
      title: '  ',
    });
    assert.equal(status, 400);
  });

  test('extra unknown fields are ignored', async () => {
    const { status } = await postJson(SCRIPT, {
      topic: 'nix',
      provider,
      temperature: 0.9,
      unexpected: true,
    });
    assert.notEqual(status, 400);
  });

  test('a null provider is a validation error', async () => {
    const { status } = await postJson(SCRIPT, { topic: 'nix', provider: null });
    assert.equal(status, 400);
  });

  test('a numeric provider is a validation error', async () => {
    const { status } = await postJson(SCRIPT, { topic: 'nix', provider: 42 });
    assert.equal(status, 400);
  });

  test('an array body is rejected', async () => {
    const { status } = await postJson(SCRIPT, [{ topic: 'nix', provider }]);
    assert.ok(status >= 400, `expected a rejection, got ${status}`);
  });
});

describe('failure isolation', () => {
  test('repeated configuration failures never become 5xx', async (t) => {
    if (unconfigured.length === 0) return t.skip('all providers configured');
    const provider = unconfigured[0];
    for (let i = 0; i < 10; i++) {
      const { status } = await postJson(SCRIPT, { topic: `t${i}`, provider });
      assert.equal(status, 503, `iteration ${i} returned ${status}`);
    }
  });

  test('concurrent provider failures leave the service healthy', async () => {
    const work = ALL_PROVIDERS.flatMap((provider) =>
      Array.from({ length: 5 }, () => postJson(SCRIPT, { topic: 'concurrent', provider })),
    );
    const results = await Promise.all(work);
    for (const { status } of results) {
      assert.ok(status < 500 || status === 503, `unexpected status ${status}`);
    }
    const { status } = await getJson(`${AI}/health`);
    assert.equal(status, 200);
  });

  test('a provider failure does not affect unrelated routes', async () => {
    await postJson(SCRIPT, { topic: 'x', provider: ALL_PROVIDERS[0] });
    const { status, json } = await postJson(`${AI}/api/generate/video`, { script: 'still works' });
    assert.equal(status, 200);
    assert.equal(json.status, 'success');
  });
});
