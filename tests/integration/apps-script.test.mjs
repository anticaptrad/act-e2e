// Public-contract smoke tests for the two Google Apps Script integrations.
//
// These checks deliberately have no access to the YouTube API key or Chat
// bridge token. They verify public readiness, fail-closed authentication, and
// redacted errors without risking channel mutations or secret exposure.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appsScript } from '../config.mjs';
import { get, getJson, postJson } from '../helpers/http.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const LEAK_MARKERS = [
  '"stack"',
  '\n    at ',
  '(line ',
  'file &quot;',
  'node:internal',
  'userCodeAppPanel',
  '__GS_INTERNAL_',
];
const APPS_SCRIPT_STORAGE_ERROR =
  /server error occurred while reading from storage|error code permission_denied/i;

function actionUrl(base, action) {
  const url = new URL(base);
  url.searchParams.set('action', action);
  return url.toString();
}

function assertJson(headers, json, context) {
  assert.match(
    headers.get('content-type') ?? '',
    /application\/json/i,
    `${context}: expected JSON content type`,
  );
  assert.notEqual(json, undefined, `${context}: expected a JSON response`);
}

function assertNoLeak(body, context) {
  for (const marker of LEAK_MARKERS) {
    assert.ok(
      !body.includes(marker),
      `${context}: response leaked internal detail (${marker})`,
    );
  }
}

async function getWithTransientRetry(url) {
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await get(url);
    if (!APPS_SCRIPT_STORAGE_ERROR.test(response.body)) return response;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  return response;
}

describe('YouTube Apps Script public HTTP profile', () => {
  test('health is public, configured, and identifies the control center', async () => {
    const { status, headers, json, body } = await getJson(
      actionUrl(appsScript.youtubeUrl, 'health'),
    );

    assert.equal(status, 200);
    assertJson(headers, json, 'YouTube health');
    assert.equal(json.ok, true);
    assert.equal(json.data?.app, 'Anticaptrad YouTube Control Center');
    assert.match(json.data?.version ?? '', SEMVER);
    assert.equal(
      json.data?.configured,
      true,
      'YouTube Apps Script setup/API key is not complete',
    );
    assertNoLeak(body, 'YouTube health');
  });

  test('root serves the API landing page, never the privileged dashboard', async () => {
    const { status, headers, body } = await getWithTransientRetry(
      appsScript.youtubeUrl,
    );

    assert.equal(status, 200);
    assert.match(headers.get('content-type') ?? '', /text\/html/i);
    assert.ok(
      /<title>Anticaptrad YouTube(?: Control Center)? API<\/title>/.test(body),
      'YouTube root did not serve the public API landing page',
    );
    assert.ok(
      !/<title>Anticaptrad YouTube Control Center<\/title>/.test(body),
      'YouTube root exposed the privileged dashboard',
    );
  });

  test('a privileged action without an API key fails closed', async () => {
    const { status, headers, json, body } = await postJson(appsScript.youtubeUrl, {
      action: 'channel',
    });

    // Apps Script ContentService communicates the semantic status in JSON.
    assert.equal(status, 200);
    assertJson(headers, json, 'YouTube missing-key rejection');
    assert.equal(json.ok, false);
    assert.equal(json.error?.code, 'UNAUTHORIZED');
    assertNoLeak(body, 'YouTube missing-key rejection');
  });

  test('malformed JSON is rejected without a stack trace', async () => {
    const { status, headers, json, body } = await postJson(
      appsScript.youtubeUrl,
      '{"action":',
    );

    assert.equal(status, 200);
    assertJson(headers, json, 'YouTube malformed JSON');
    assert.equal(json.ok, false);
    assert.equal(json.error?.code, 'INVALID_JSON');
    assertNoLeak(body, 'YouTube malformed JSON');
  });
});

describe('Google Chat bridge public contract', () => {
  test('health is public, configured, and identifies the bridge', async () => {
    const { status, headers, json, body } = await getJson(
      actionUrl(appsScript.chatBridgeUrl, 'health'),
    );

    assert.equal(status, 200);
    assertJson(headers, json, 'Chat bridge health');
    assert.equal(json.ok, true);
    assert.equal(json.service, 'google-chat-linear-bridge');
    assert.match(json.version ?? '', SEMVER);
    assert.equal(json.configured, true);
    assertNoLeak(body, 'Chat bridge health');
  });

  test('a privileged action without a token fails closed', async () => {
    const { status, headers, json, body } = await postJson(appsScript.chatBridgeUrl, {
      action: 'status',
    });

    assert.equal(status, 200);
    assertJson(headers, json, 'Chat bridge missing-token rejection');
    assert.equal(json.ok, false);
    assert.equal(json.error?.code, 'unauthorized');
    assert.equal(json.error?.status, 401);
    assertNoLeak(body, 'Chat bridge missing-token rejection');
  });

  test('malformed JSON is rejected without a stack trace', async () => {
    const { status, headers, json, body } = await postJson(
      appsScript.chatBridgeUrl,
      '{"action":',
    );

    assert.equal(status, 200);
    assertJson(headers, json, 'Chat bridge malformed JSON');
    assert.equal(json.ok, false);
    assert.equal(json.error?.code, 'invalid_json');
    assert.equal(json.error?.status, 400);
    assertNoLeak(body, 'Chat bridge malformed JSON');
  });
});
