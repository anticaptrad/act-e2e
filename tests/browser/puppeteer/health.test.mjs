// Puppeteer interop: attach to the remote Chrome exposed by the cluster's
// Puppeteer service (CDP) and exercise the AntiCapTrad services through it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { browsers, browserServices, timeoutMs } from '../../config.mjs';

let browser;

before(async () => {
  browser = await puppeteer.connect({ browserWSEndpoint: browsers.puppeteerWsEndpoint });
});

after(async () => {
  if (browser) await browser.disconnect();
});

async function withPage(fn) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

describe('remote browser session', () => {
  test('attaches over CDP and reports a version', async () => {
    assert.ok(browser.connected, 'browser should be connected');
    assert.match(await browser.version(), /Chrom/i);
  });

  test('exposes a websocket endpoint', async () => {
    assert.match(browser.wsEndpoint(), /^wss?:\/\//);
  });
});

describe('service reachability', () => {
  for (const [name, base] of Object.entries(browserServices)) {
    test(`${name}: /health loads with a non-error status`, async () => {
      await withPage(async (page) => {
        const response = await page.goto(`${base}/health`, { timeout: timeoutMs });
        assert.ok(response, 'expected a navigation response');
        assert.ok(response.status() < 400, `expected < 400, got ${response.status()}`);
        assert.match(await response.text(), /ok/i);
      });
    });
  }

  test('unknown routes surface a 404 to the browser', async () => {
    await withPage(async (page) => {
      const response = await page.goto(`${browserServices.mcp}/nope-e2e`, { timeout: timeoutMs });
      assert.equal(response.status(), 404);
    });
  });

  test('responses carry a JSON content type', async () => {
    await withPage(async (page) => {
      const response = await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      assert.match(response.headers()['content-type'] ?? '', /application\/json/);
    });
  });
});

describe('in-page JavaScript against the services', () => {
  test('readiness JSON parses inside the browser', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.web}/health`, { timeout: timeoutMs });
      const ready = await page.evaluate(async () => {
        const res = await fetch('/ready');
        return res.json();
      });
      assert.equal(ready.ready, true);
      assert.equal(typeof ready.database_connected, 'boolean');
    });
  });

  test('a same-origin POST drives the MCP JSON-RPC endpoint', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.mcp}/health`, { timeout: timeoutMs });
      const result = await page.evaluate(async () => {
        const res = await fetch('/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: { name: 'ping', arguments: { message: 'from-puppeteer' } },
          }),
        });
        return res.json();
      });
      assert.equal(result.id, 9);
      assert.equal(result.result.content[0].text, 'from-puppeteer');
    });
  });

  test('an unauthenticated protected route returns 401 from the browser', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.web}/health`, { timeout: timeoutMs });
      const status = await page.evaluate(async () => {
        const res = await fetch('/api/me');
        return res.status;
      });
      assert.equal(status, 401);
    });
  });
});

describe('browser diagnostics', () => {
  test('page metrics are collected without error', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const metrics = await page.metrics();
      assert.ok(typeof metrics.Timestamp === 'number');
    });
  });

  test('a screenshot can be captured of a service response', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.ai}/health`, { timeout: timeoutMs });
      const shot = await page.screenshot();
      assert.ok(shot.length > 0, 'expected non-empty screenshot bytes');
    });
  });
});
