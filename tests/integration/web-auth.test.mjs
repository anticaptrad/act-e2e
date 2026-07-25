// Supabase JWT verification on act-web-server.
//
// The middleware must fail closed: only a correctly signed, unexpired token
// with the expected audience may reach a protected route. Everything else —
// including a forged `alg: none` token — must be rejected.
//
// Requires SUPABASE_JWT_SECRET to match the server under test; the suite skips
// itself otherwise so it stays runnable against an environment whose secret we
// do not hold.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services, supabase } from '../config.mjs';
import { get, getJson } from '../helpers/http.mjs';
import { baseClaims, forgeAlgNone, nowSeconds, signHs256 } from '../helpers/jwt.mjs';

const ME = `${services.web}/api/me`;
const skip = supabase.jwtSecret ? false : 'SUPABASE_JWT_SECRET not set';

const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

describe('protected route rejects bad credentials', { skip }, () => {
  const rejected = [
    ['no Authorization header', undefined],
    ['a non-JWT string', 'not-a-jwt'],
    ['an empty bearer token', ''],
    ['a JWT with only two segments', 'aaa.bbb'],
    ['garbage in the signature slot', `${signHs256(baseClaims()).split('.').slice(0, 2).join('.')}.tampered`],
  ];

  for (const [label, token] of rejected) {
    test(`rejects ${label}`, async () => {
      const options = token === undefined ? {} : bearer(token);
      const { status } = await get(ME, options);
      assert.equal(status, 401);
    });
  }

  test('rejects a non-Bearer scheme', async () => {
    const { status } = await get(ME, { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });
    assert.equal(status, 401);
  });

  test('rejects an expired token', async () => {
    const token = signHs256(baseClaims({ exp: nowSeconds() - 3600 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401);
  });

  test('rejects a token signed with the wrong secret', async () => {
    const token = signHs256(baseClaims(), 'a-completely-different-secret');
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401);
  });

  test('rejects a token for the wrong audience', async () => {
    const token = signHs256(baseClaims({ aud: 'some-other-service' }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401);
  });

  test('rejects a forged alg:none token (algorithm confusion)', async () => {
    // The classic JWT vulnerability: if the verifier honours the token's own
    // `alg` header instead of its pinned algorithm, this unsigned token is
    // accepted and auth is completely bypassed.
    const { status } = await get(ME, bearer(forgeAlgNone(baseClaims())));
    assert.equal(status, 401);
  });

  test('rejects a tampered payload under a valid signature', async () => {
    // Re-encode the claims with escalated privileges but keep the original
    // signature — the HMAC must no longer match.
    const [header, , signature] = signHs256(baseClaims()).split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify(baseClaims({ role: 'service_role', sub: 'admin' })),
    ).toString('base64url');
    const { status } = await get(ME, bearer(`${header}.${forgedPayload}.${signature}`));
    assert.equal(status, 401);
  });
});

describe('protected route accepts a valid token', { skip }, () => {
  test('returns 200 for a correctly signed token', async () => {
    const { status } = await get(ME, bearer(signHs256(baseClaims())));
    assert.equal(status, 200);
  });

  test('returns the verified claims', async () => {
    const claims = baseClaims({ sub: 'user-xyz-999', email: 'verified@example.com' });
    const { status, json } = await getJson(ME, bearer(signHs256(claims)));
    assert.equal(status, 200);
    assert.equal(json.sub, 'user-xyz-999');
    assert.equal(json.email, 'verified@example.com');
    assert.equal(json.role, 'authenticated');
  });

  test('never echoes the raw token back', async () => {
    const token = signHs256(baseClaims());
    const { body } = await get(ME, bearer(token));
    assert.ok(!body.includes(token), 'response must not leak the bearer token');
  });

  test('a token expiring far in the future is accepted', async () => {
    const token = signHs256(baseClaims({ exp: nowSeconds() + 86_400 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 200);
  });

  test('distinct users get their own identity back', async () => {
    for (const sub of ['alice-1', 'bob-2', 'carol-3']) {
      const { json } = await getJson(ME, bearer(signHs256(baseClaims({ sub }))));
      assert.equal(json.sub, sub);
    }
  });
});

describe('auth does not affect public routes', () => {
  test('probes stay reachable with no token', async () => {
    for (const path of ['/health', '/ready']) {
      const { status } = await get(`${services.web}${path}`);
      assert.equal(status, 200);
    }
  });

  test('probes stay reachable even with a garbage token', async () => {
    const { status } = await get(`${services.web}/health`, bearer('total-garbage'));
    assert.equal(status, 200);
  });
});
