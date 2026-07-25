// Minimal HS256 JWT minting for auth tests.
//
// Hand-rolled with node:crypto rather than a library: the tests must be able to
// produce deliberately malformed tokens (wrong signature, `alg: none`, expired,
// wrong audience) that a well-behaved signing library would refuse to emit.
import crypto from 'node:crypto';
import { supabase } from '../config.mjs';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** Claims for a normal signed-in Supabase user. */
export function baseClaims(overrides = {}) {
  return {
    sub: 'e2e-user-0001',
    email: 'e2e@example.com',
    role: 'authenticated',
    aud: supabase.jwtAud,
    exp: nowSeconds() + 3600,
    ...overrides,
  };
}

/** Sign claims with HS256. Defaults to the configured Supabase secret. */
export function signHs256(claims, secret = supabase.jwtSecret) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url(claims);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Forge an unsigned `alg: none` token. A correct verifier pinned to HS256 must
 * reject this outright — accepting it is the classic JWT algorithm-confusion
 * vulnerability.
 */
export function forgeAlgNone(claims) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}
