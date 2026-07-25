// Latency and throughput budgets.
//
// These are deliberately generous smoke budgets, not benchmarks: they exist to
// catch a pathological regression (a probe that suddenly blocks on I/O, an
// accidental sleep, a lock held across a request) rather than to measure
// performance. Override with E2E_LATENCY_BUDGET_MS on slower hardware.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { services } from '../config.mjs';
import { get, postJson } from '../helpers/http.mjs';

const BUDGET_MS = Number(process.env.E2E_LATENCY_BUDGET_MS ?? 1500);
const ALL = Object.entries(services);

/** Time a single call in milliseconds. */
async function timed(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

describe('probe latency', () => {
  for (const [name, base] of ALL) {
    test(`${name}: /health p95 is within budget`, async () => {
      const samples = [];
      for (let i = 0; i < 30; i++) {
        samples.push(await timed(() => get(`${base}/health`)));
      }
      const p95 = percentile(samples, 95);
      assert.ok(p95 < BUDGET_MS, `${name} /health p95 was ${p95.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
    });

    test(`${name}: /ready p95 is within budget`, async () => {
      const samples = [];
      for (let i = 0; i < 20; i++) {
        samples.push(await timed(() => get(`${base}/ready`)));
      }
      const p95 = percentile(samples, 95);
      assert.ok(p95 < BUDGET_MS, `${name} /ready p95 was ${p95.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
    });
  }
});

describe('probes do not block on dependencies', () => {
  test('readiness is as fast as liveness', async () => {
    // If readiness ever starts issuing a live query to Postgres or NATS it will
    // show up here as a step change against the dependency-free /health.
    for (const [name, base] of ALL) {
      const health = [];
      const ready = [];
      for (let i = 0; i < 15; i++) {
        health.push(await timed(() => get(`${base}/health`)));
        ready.push(await timed(() => get(`${base}/ready`)));
      }
      const gap = percentile(ready, 90) - percentile(health, 90);
      assert.ok(gap < BUDGET_MS, `${name} readiness lags liveness by ${gap.toFixed(1)}ms`);
    }
  });
});

describe('throughput', () => {
  test('a burst of concurrent probes all complete', async () => {
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => get(`${services.api}/health`)),
    );
    const elapsed = performance.now() - started;
    assert.equal(results.filter((r) => r.status === 200).length, 100);
    assert.ok(elapsed < BUDGET_MS * 20, `100 concurrent probes took ${elapsed.toFixed(0)}ms`);
  });

  test('the MCP endpoint sustains concurrent RPCs', async () => {
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        postJson(`${services.mcp}/mcp`, { jsonrpc: '2.0', id: i, method: 'ping' }),
      ),
    );
    const elapsed = performance.now() - started;
    assert.equal(results.filter((r) => r.status === 200).length, 50);
    assert.ok(elapsed < BUDGET_MS * 20, `50 concurrent RPCs took ${elapsed.toFixed(0)}ms`);
  });

  test('latency does not degrade across a sustained run', async () => {
    const first = [];
    const last = [];
    for (let i = 0; i < 60; i++) {
      const ms = await timed(() => get(`${services.api}/health`));
      (i < 20 ? first : i >= 40 ? last : []).push(ms);
    }
    const drift = percentile(last, 90) - percentile(first, 90);
    assert.ok(drift < BUDGET_MS, `latency drifted by ${drift.toFixed(1)}ms over the run`);
  });
});
