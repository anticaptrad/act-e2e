// Startup behaviour across environment configurations.
//
// The platform's operational contract is that optional dependencies fail *soft*
// (a missing broker or database must not stop the service answering probes)
// while auth fails *closed* (an unconfigured signing secret must deny, never
// allow). Both are startup-time behaviours, so they can only be tested by
// owning the process and choosing its environment.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { freePort, skipUnlessBuilt, startService } from '../helpers/spawn.mjs';
import { baseClaims, signHs256 } from '../helpers/jwt.mjs';

const json = async (url, options) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

describe('optional dependencies fail soft', { skip: skipUnlessBuilt('api', 'web') }, () => {
  test('api starts and serves probes with no broker reachable', async () => {
    // Port 1 is reserved and never listening, so this is a guaranteed-dead URL.
    const svc = await startService('api', { NATS_URL: 'nats://127.0.0.1:1' });
    try {
      const health = await json(`${svc.url}/health`);
      assert.equal(health.status, 200);
      const ready = await json(`${svc.url}/ready`);
      assert.equal(ready.status, 200);
      assert.equal(ready.body.ready, true, 'readiness must not gate on the broker');
      assert.equal(ready.body.nats_connected, false);
    } finally {
      await svc.stop();
    }
  });

  test('api logs the broker failure rather than dying silently', async () => {
    const svc = await startService('api', { NATS_URL: 'nats://127.0.0.1:1' });
    try {
      assert.match(svc.logText(), /NATS unavailable|continuing without/i);
    } finally {
      await svc.stop();
    }
  });

  test('web starts and serves probes with no database configured', async () => {
    const svc = await startService('web', { SUPABASE_JWT_SECRET: 'x'.repeat(32) });
    try {
      const ready = await json(`${svc.url}/ready`);
      assert.equal(ready.status, 200);
      assert.equal(ready.body.ready, true, 'readiness must not gate on the database');
      assert.equal(ready.body.database_connected, false);
    } finally {
      await svc.stop();
    }
  });

  test('web starts even when the database URL is unreachable', async () => {
    const svc = await startService('web', {
      SUPABASE_JWT_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nothing',
    });
    try {
      const ready = await json(`${svc.url}/ready`);
      assert.equal(ready.status, 200);
      assert.equal(ready.body.database_connected, false);
      assert.match(svc.logText(), /database unavailable|without persistence/i);
    } finally {
      await svc.stop();
    }
  });
});

describe('auth fails closed', { skip: skipUnlessBuilt('web') }, () => {
  test('a protected route is denied when no signing secret is configured', async () => {
    // The dangerous failure mode is the opposite: treating "no secret" as
    // "no verification required" and letting everything through.
    const svc = await startService('web');
    try {
      const anon = await json(`${svc.url}/api/me`);
      assert.equal(anon.status, 503);

      const signed = await json(`${svc.url}/api/me`, {
        headers: { Authorization: `Bearer ${signHs256(baseClaims(), 'any-secret-at-all')}` },
      });
      assert.equal(signed.status, 503, 'a signed token must not bypass a missing secret');
    } finally {
      await svc.stop();
    }
  });

  test('probes stay public when auth is unconfigured', async () => {
    const svc = await startService('web');
    try {
      assert.equal((await json(`${svc.url}/health`)).status, 200);
      assert.equal((await json(`${svc.url}/ready`)).status, 200);
    } finally {
      await svc.stop();
    }
  });

  test('the missing secret is logged loudly at startup', async () => {
    const svc = await startService('web');
    try {
      assert.match(svc.logText(), /SUPABASE_JWT_SECRET not set/i);
    } finally {
      await svc.stop();
    }
  });

  test('an empty secret is treated as unconfigured, not as a valid key', async () => {
    const svc = await startService('web', { SUPABASE_JWT_SECRET: '' });
    try {
      const res = await json(`${svc.url}/api/me`, {
        headers: { Authorization: `Bearer ${signHs256(baseClaims(), '')}` },
      });
      assert.equal(res.status, 503, 'an empty secret must not authenticate anyone');
    } finally {
      await svc.stop();
    }
  });

  test('a configured secret enables verification', async () => {
    const secret = 'a-real-secret-for-this-test';
    const svc = await startService('web', { SUPABASE_JWT_SECRET: secret });
    try {
      const ok = await json(`${svc.url}/api/me`, {
        headers: { Authorization: `Bearer ${signHs256(baseClaims(), secret)}` },
      });
      assert.equal(ok.status, 200);

      const wrong = await json(`${svc.url}/api/me`, {
        headers: { Authorization: `Bearer ${signHs256(baseClaims(), 'not-the-secret')}` },
      });
      assert.equal(wrong.status, 401);
    } finally {
      await svc.stop();
    }
  });
});

describe('audience and issuer are configurable', { skip: skipUnlessBuilt('web') }, () => {
  const secret = 'audience-test-secret';

  test('a custom audience is honoured', async () => {
    const svc = await startService('web', {
      SUPABASE_JWT_SECRET: secret,
      SUPABASE_JWT_AUD: 'my-custom-audience',
    });
    try {
      const matching = await json(`${svc.url}/api/me`, {
        headers: {
          Authorization: `Bearer ${signHs256(baseClaims({ aud: 'my-custom-audience' }), secret)}`,
        },
      });
      assert.equal(matching.status, 200);

      const defaultAud = await json(`${svc.url}/api/me`, {
        headers: {
          Authorization: `Bearer ${signHs256(baseClaims({ aud: 'authenticated' }), secret)}`,
        },
      });
      assert.equal(defaultAud.status, 401, 'the default audience must not be accepted');
    } finally {
      await svc.stop();
    }
  });

  test('issuer pinning rejects a token from another issuer', async () => {
    const svc = await startService('web', {
      SUPABASE_JWT_SECRET: secret,
      SUPABASE_JWT_ISS: 'https://expected.supabase.co/auth/v1',
    });
    try {
      const right = await json(`${svc.url}/api/me`, {
        headers: {
          Authorization: `Bearer ${signHs256(
            baseClaims({ iss: 'https://expected.supabase.co/auth/v1' }),
            secret,
          )}`,
        },
      });
      assert.equal(right.status, 200);

      const wrong = await json(`${svc.url}/api/me`, {
        headers: {
          Authorization: `Bearer ${signHs256(
            baseClaims({ iss: 'https://attacker.example.com/auth/v1' }),
            secret,
          )}`,
        },
      });
      assert.equal(wrong.status, 401);
    } finally {
      await svc.stop();
    }
  });

  test('leeway is configurable', async () => {
    const svc = await startService('web', {
      SUPABASE_JWT_SECRET: secret,
      SUPABASE_JWT_LEEWAY_SECS: '120',
    });
    try {
      const nowish = Math.floor(Date.now() / 1000);
      const res = await json(`${svc.url}/api/me`, {
        headers: {
          Authorization: `Bearer ${signHs256(baseClaims({ exp: nowish - 60 }), secret)}`,
        },
      });
      assert.equal(res.status, 200, 'a 120s leeway should accept a token 60s past expiry');
    } finally {
      await svc.stop();
    }
  });
});

describe('port configuration', { skip: skipUnlessBuilt('api', 'ai') }, () => {
  test('PORT is honoured by the Rust services', async () => {
    const port = await freePort();
    const svc = await startService('api', {}, { port });
    try {
      assert.equal(svc.port, port);
      assert.equal((await json(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
      await svc.stop();
    }
  });

  test('PORT is honoured by the AI server', async () => {
    const port = await freePort();
    const svc = await startService('ai', {}, { port });
    try {
      assert.equal((await json(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
      await svc.stop();
    }
  });

  test('an unparseable PORT falls back to the default rather than crashing', async () => {
    // A typo'd ConfigMap must not panic the process; the value is parsed
    // leniently and falls back to 8080.
    //
    // Whether the bind then succeeds depends on the machine — a local dev stack
    // may already own 8080 — so assert on what is invariant: startup proceeds
    // past config without panicking, and the address it settles on is the
    // default, either bound or reported as unavailable.
    const svc = await startService('api', { PORT: 'not-a-number' }, { waitForHealth: false });
    try {
      const deadline = Date.now() + 8000;
      while (
        Date.now() < deadline &&
        svc.exit === null &&
        !/listening/i.test(svc.logText())
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }

      const log = svc.logText();
      assert.ok(!/panic/i.test(log), `unparseable PORT panicked: ${log.slice(-300)}`);
      assert.match(log, /telemetry|NATS|listening/i, 'service aborted before reaching startup');

      const boundDefault = /addr=0\.0\.0\.0:8080/.test(log);
      const bindRefused = svc.exit !== null && svc.exit.code !== 0;
      assert.ok(
        boundDefault || bindRefused,
        `expected the default port to be used or reported busy: ${log.slice(-300)}`,
      );
    } finally {
      await svc.stop().catch(() => svc.proc.kill('SIGKILL'));
    }
  });
});
