// JWT claim validation on act-web-server.
//
// web-auth.test.mjs covers signature and transport-level rejection; this file
// covers the claim set itself. Several of these pin hardening that closed real
// gaps in the default `jsonwebtoken` configuration:
//
//   * `nbf` is not validated by default, so a not-yet-valid token was accepted.
//   * Audience matching is skipped entirely when the token carries no `aud`,
//     so a token minted for another service was accepted.
//   * The default 60s expiry leeway was wider than this platform needs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services, supabase } from '../config.mjs';
import { get, getJson } from '../helpers/http.mjs';
import { baseClaims, nowSeconds, signHs256 } from '../helpers/jwt.mjs';

const ME = `${services.web}/api/me`;
const skip = supabase.jwtSecret ? false : 'SUPABASE_JWT_SECRET not set';
const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Sign a claim set with the `aud` field omitted entirely. */
function signWithoutAud(overrides = {}) {
  const claims = baseClaims(overrides);
  delete claims.aud;
  return signHs256(claims);
}

describe('required claims', { skip }, () => {
  test('a token with no exp is rejected', async () => {
    const claims = baseClaims();
    delete claims.exp;
    const { status } = await get(ME, bearer(signHs256(claims)));
    assert.equal(status, 401);
  });

  test('a token with no sub is rejected', async () => {
    const claims = baseClaims();
    delete claims.sub;
    const { status } = await get(ME, bearer(signHs256(claims)));
    assert.equal(status, 401);
  });

  test('a token with no aud is rejected', async () => {
    // Without this, audience validation is silently skipped and a token minted
    // for a different service authenticates here.
    const { status } = await get(ME, bearer(signWithoutAud()));
    assert.equal(status, 401);
  });

  test('optional claims may be absent', async () => {
    const claims = baseClaims();
    delete claims.email;
    delete claims.role;
    const { status, json } = await getJson(ME, bearer(signHs256(claims)));
    assert.equal(status, 200);
    assert.equal(json.sub, claims.sub);
  });
});

describe('temporal claims', { skip }, () => {
  test('a not-yet-valid token (nbf in the future) is rejected', async () => {
    const token = signHs256(baseClaims({ nbf: nowSeconds() + 3600, exp: nowSeconds() + 7200 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401);
  });

  test('a token whose nbf has passed is accepted', async () => {
    const token = signHs256(baseClaims({ nbf: nowSeconds() - 60 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 200);
  });

  test('expiry leeway is narrow, not the 60s default', async () => {
    const token = signHs256(baseClaims({ exp: nowSeconds() - 30 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401, 'a token 30s past expiry should not be accepted');
  });

  test('a token just inside the leeway window still works', async () => {
    // Some tolerance is deliberate: nodes disagree about the clock.
    const token = signHs256(baseClaims({ exp: nowSeconds() - 1 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 200);
  });

  test('an iat in the past is not an obstacle', async () => {
    const token = signHs256(baseClaims({ iat: nowSeconds() - 600 }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 200);
  });
});

describe('audience matching', { skip }, () => {
  test('an aud array containing the expected value is accepted', async () => {
    const token = signHs256(baseClaims({ aud: [supabase.jwtAud, 'another-service'] }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 200);
  });

  test('an aud array without the expected value is rejected', async () => {
    const token = signHs256(baseClaims({ aud: ['some-service', 'another-service'] }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401);
  });

  test('an empty aud array is rejected', async () => {
    const { status } = await get(ME, bearer(signHs256(baseClaims({ aud: [] }))));
    assert.equal(status, 401);
  });

  test('audience matching is exact, not a prefix', async () => {
    const token = signHs256(baseClaims({ aud: `${supabase.jwtAud}-extra` }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 401);
  });
});

describe('claim content is passed through faithfully', { skip }, () => {
  test('unusual but valid claim values survive verification', async () => {
    const claims = baseClaims({
      sub: 'a'.repeat(200),
      email: 'ünïcode+tag@example.co.uk',
    });
    const { status, json } = await getJson(ME, bearer(signHs256(claims)));
    assert.equal(status, 200);
    assert.equal(json.sub, claims.sub);
    assert.equal(json.email, claims.email);
  });

  test('unknown extra claims are ignored, not rejected', async () => {
    const token = signHs256(baseClaims({ app_metadata: { plan: 'pro' }, custom: [1, 2, 3] }));
    const { status } = await get(ME, bearer(token));
    assert.equal(status, 200);
  });

  test('only the whitelisted claims are echoed back', async () => {
    const token = signHs256(baseClaims({ app_metadata: { secret_flag: 'do-not-echo' } }));
    const { json, body } = await getJson(ME, bearer(token));
    assert.deepEqual(Object.keys(json).sort(), ['email', 'role', 'sub']);
    assert.ok(!body.includes('do-not-echo'), 'response echoed an unrelated claim');
  });

  test('the role claim is reported as signed', async () => {
    const { json } = await getJson(ME, bearer(signHs256(baseClaims({ role: 'service_role' }))));
    assert.equal(json.role, 'service_role');
  });
});
