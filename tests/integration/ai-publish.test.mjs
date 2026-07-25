// act-ai-server publishing path.
//
// `/api/publish/youtube` takes a `filePath` from the request body. Without
// containment that is an arbitrary-file-read primitive: any file the process
// can open — a service-account token, /etc/passwd, another tenant's render —
// could be named and uploaded to an external platform. Uploading it "privately"
// still exfiltrates it.
//
// These assert the endpoint refuses to read outside its upload directory, and
// that it distinguishes "not configured" from "bad request" so an operator can
// tell a missing credential from a bad payload.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { getJson, postJson } from '../helpers/http.mjs';

const AI = services.ai;
const PUBLISH = `${AI}/api/publish/youtube`;

let youtubeConfigured = false;

before(async () => {
  const { json } = await getJson(`${AI}/ready`);
  youtubeConfigured = json.youtube === 'configured';
});

describe('readiness reports the publishing path', () => {
  test('/ready states whether YouTube is configured', async () => {
    const { json } = await getJson(`${AI}/ready`);
    assert.ok(
      ['configured', 'not configured'].includes(json.youtube),
      `unexpected youtube status: ${json.youtube}`,
    );
  });

  test('publishing config never gates readiness', async () => {
    const { json } = await getJson(`${AI}/ready`);
    assert.equal(json.ready, true, 'an unconfigured publisher must not fail readiness');
  });

  test('readiness does not leak credential material', async () => {
    const { body } = await getJson(`${AI}/ready`);
    assert.ok(!/ya29\.|1\/\/|client_secret/i.test(body), 'response looks like it carries a token');
  });
});

describe('request validation', () => {
  const badRequests = [
    ['an empty body', {}],
    ['a missing title', { filePath: 'render.mp4' }],
    ['a missing filePath', { title: 'My Video' }],
    ['a blank filePath', { filePath: '   ', title: 'My Video' }],
    ['a blank title', { filePath: 'render.mp4', title: '  ' }],
  ];

  for (const [label, payload] of badRequests) {
    test(`rejects ${label} with 400`, async () => {
      const { status, json } = await postJson(PUBLISH, payload);
      assert.equal(status, 400);
      assert.ok(json.error);
    });
  }

  test('validation runs before any upload is attempted', async () => {
    const started = Date.now();
    const { status } = await postJson(PUBLISH, {});
    assert.equal(status, 400);
    assert.ok(Date.now() - started < 2000, 'validation should short-circuit');
  });
});

describe('the upload directory is a hard boundary', () => {
  // Every one of these names a file that exists on a typical host but must
  // never be reachable through this endpoint.
  const escapes = [
    ['a parent-directory traversal', '../../../../etc/passwd'],
    ['an absolute path outside the root', '/etc/passwd'],
    ['an absolute path to a host secret', '/etc/shadow'],
    ['a traversal buried mid-path', 'renders/../../../../etc/hosts'],
    ['a doubled-up traversal', '....//....//etc/passwd'],
    ['a URL-encoded traversal', '%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['a home-directory escape', '/root/.ssh/id_rsa'],
    ['a proc self environ read', '/proc/self/environ'],
    ['a kubernetes service-account token', '/var/run/secrets/kubernetes.io/serviceaccount/token'],
  ];

  for (const [label, filePath] of escapes) {
    test(`refuses ${label}`, async (t) => {
      if (!youtubeConfigured) {
        // Unconfigured, the route answers 503 before path resolution, so the
        // containment assertion would be vacuous.
        t.skip('YouTube not configured — containment covered by the unit path');
        return;
      }
      const { status, body } = await postJson(PUBLISH, { filePath, title: 'exfil attempt' });
      assert.ok(status >= 400, `${filePath} was accepted with ${status}`);
      assert.ok(!body.includes('videoId'), `${filePath} produced an upload`);
      assert.ok(!/root:x:/.test(body), 'response leaked file contents');
    });
  }

  test('an escape attempt never reports the resolved host path', async (t) => {
    if (!youtubeConfigured) return t.skip('YouTube not configured');
    const { body } = await postJson(PUBLISH, {
      filePath: '../../../../etc/passwd',
      title: 'probe',
    });
    // Echoing the resolved path would confirm what exists outside the root.
    assert.ok(!body.includes('/etc/passwd'), 'error echoed the probed path');
  });

  test('a nonexistent file inside the root is a clean 404, not a 500', async (t) => {
    if (!youtubeConfigured) return t.skip('YouTube not configured');
    const { status } = await postJson(PUBLISH, {
      filePath: 'definitely-not-here-e2e.mp4',
      title: 'probe',
    });
    assert.equal(status, 404);
  });

  test('an unsupported extension is refused', async (t) => {
    if (!youtubeConfigured) return t.skip('YouTube not configured');
    const { status } = await postJson(PUBLISH, { filePath: 'notes.txt', title: 'probe' });
    // 415 when the file exists, 404 when it does not — both are refusals.
    assert.ok([404, 415].includes(status), `expected 404/415, got ${status}`);
  });
});

describe('configuration errors are distinguishable', () => {
  test('an unconfigured publisher answers 503, not 502', async (t) => {
    if (youtubeConfigured) return t.skip('YouTube is configured in this environment');
    const { status, json } = await postJson(PUBLISH, {
      filePath: 'render.mp4',
      title: 'probe',
    });
    assert.equal(status, 503, 'a missing credential is not a bad gateway');
    assert.match(json.error, /not configured/i);
  });

  test('the error names the missing variables so it is actionable', async (t) => {
    if (youtubeConfigured) return t.skip('YouTube is configured in this environment');
    const { json } = await postJson(PUBLISH, { filePath: 'render.mp4', title: 'probe' });
    assert.match(json.error, /YOUTUBE_/, 'error should name the missing env vars');
  });

  test('a failed publish never takes the service down', async () => {
    for (let i = 0; i < 5; i++) {
      await postJson(PUBLISH, { filePath: `probe-${i}.mp4`, title: 'probe' });
    }
    const { status, json } = await getJson(`${AI}/health`);
    assert.equal(status, 200);
    assert.equal(json.status, 'ok');
  });
});
