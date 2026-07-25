// Graceful shutdown.
//
// Every service installs a SIGTERM handler so a k8s rolling update drains
// in-flight work instead of severing it. That path is invisible to a suite that
// only talks to a running deployment, so these tests own the process: start it,
// put work in flight, signal it, and check both the request and the exit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessBuilt, startService, waitForHttp } from '../helpers/spawn.mjs';

const RUST = ['api', 'web', 'mcp'];

describe('services exit cleanly on SIGTERM', { skip: skipUnlessBuilt(...RUST) }, () => {
  for (const name of RUST) {
    test(`${name}: SIGTERM produces a zero exit`, async () => {
      const svc = await startService(name);
      const exit = await svc.stop('SIGTERM');
      assert.equal(exit.code, 0, `${name} exited with ${JSON.stringify(exit)}`);
    });

    test(`${name}: shutdown is logged before exit`, async () => {
      const svc = await startService(name);
      await svc.stop('SIGTERM');
      assert.match(svc.logText(), /shutdown/i, `${name} logged no shutdown`);
    });

    test(`${name}: the port is released after exit`, async () => {
      const svc = await startService(name);
      const { url } = svc;
      await svc.stop('SIGTERM');
      // A released port means the next pod can bind it immediately.
      await assert.rejects(
        () => fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }),
        'service still accepted a connection after shutdown',
      );
    });
  }

  test('SIGINT also shuts down cleanly', async () => {
    const svc = await startService('mcp');
    const exit = await svc.stop('SIGINT');
    assert.equal(exit.code, 0);
  });

  test('a service handles requests right up to the signal', async () => {
    const svc = await startService('api');
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${svc.url}/health`, { signal: AbortSignal.timeout(2000) });
      assert.equal(res.status, 200);
    }
    const exit = await svc.stop('SIGTERM');
    assert.equal(exit.code, 0);
  });
});

describe('in-flight requests are drained', { skip: skipUnlessBuilt('ai') }, () => {
  test('a request in progress completes after SIGTERM arrives', async () => {
    // /api/generate/video deliberately takes ~2s, which is long enough to have
    // a request genuinely in flight when the signal lands. Severing it instead
    // of draining would surface here as a transport error.
    const svc = await startService('ai');
    try {
      const inFlight = fetch(`${svc.url}/api/generate/video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'drain me' }),
        signal: AbortSignal.timeout(20_000),
      });

      // Let the handler start, then ask the process to stop.
      await new Promise((r) => setTimeout(r, 250));
      svc.proc.kill('SIGTERM');

      const res = await inFlight;
      assert.equal(res.status, 200, 'in-flight request was not drained');
      const body = await res.json();
      assert.equal(body.status, 'success');
    } finally {
      await svc.stop('SIGTERM').catch(() => svc.proc.kill('SIGKILL'));
    }
  });

  test('the process exits after draining rather than hanging', async () => {
    const svc = await startService('ai');
    const inFlight = fetch(`${svc.url}/api/generate/video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'drain then exit' }),
      signal: AbortSignal.timeout(20_000),
      // Consume the body: an unread response keeps the connection active.
    }).then((r) => r.text(), () => null);

    await new Promise((r) => setTimeout(r, 250));
    const exit = await svc.stop('SIGTERM', 15_000);
    await inFlight;
    assert.equal(exit.code, 0, 'service should exit 0 once drained');
  });

  test('shutdown is bounded when a client never reads its response', async () => {
    // A client that leaves the body unread keeps the connection active, so an
    // unbounded drain would hold the pod open until the kubelet SIGKILLed it.
    // The grace period must cap that.
    const svc = await startService('ai', { SHUTDOWN_GRACE_MS: '2000' });
    try {
      // Deliberately never read the body.
      const rude = fetch(`${svc.url}/api/generate/video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'never read' }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);

      await new Promise((r) => setTimeout(r, 250));
      const started = Date.now();
      const exit = await svc.stop('SIGTERM', 12_000);
      const elapsed = Date.now() - started;

      assert.equal(exit.code, 0, 'service should still exit 0');
      assert.ok(elapsed < 10_000, `shutdown took ${elapsed}ms despite a 2s grace period`);
      await rude;
    } finally {
      if (svc.exit === null) svc.proc.kill('SIGKILL');
    }
  });

  test('the forced exit is logged so operators can see it', async () => {
    const svc = await startService('ai', { SHUTDOWN_GRACE_MS: '1000' });
    try {
      fetch(`${svc.url}/api/generate/video`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'unread' }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);

      await new Promise((r) => setTimeout(r, 250));
      await svc.stop('SIGTERM', 12_000);
      assert.match(svc.logText(), /grace period elapsed/i);
    } finally {
      if (svc.exit === null) svc.proc.kill('SIGKILL');
    }
  });

  test('the AI server logs its shutdown', async () => {
    const svc = await startService('ai');
    await svc.stop('SIGTERM');
    assert.match(svc.logText(), /shutting down|SIGTERM/i);
  });
});

describe('restart behaviour', { skip: skipUnlessBuilt('mcp') }, () => {
  test('a service can be restarted on the same port', async () => {
    const first = await startService('mcp');
    const { port, url } = first;
    await first.stop('SIGTERM');

    // Rebinding immediately is what a rolling update does; a lingering socket
    // would fail here with EADDRINUSE.
    const second = await startService('mcp', {}, { port });
    try {
      assert.ok(await waitForHttp(`${url}/health`, 10_000), 'restarted service not healthy');
    } finally {
      await second.stop('SIGTERM');
    }
  });

  test('repeated start/stop cycles stay clean', async () => {
    for (let i = 0; i < 3; i++) {
      const svc = await startService('mcp');
      const exit = await svc.stop('SIGTERM');
      assert.equal(exit.code, 0, `cycle ${i} exited ${JSON.stringify(exit)}`);
    }
  });
});
