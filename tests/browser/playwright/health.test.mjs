// Playwright interop: drive the remote Chromium exposed by the cluster's
// Playwright service and exercise the AntiCapTrad services through it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browsers, browserServices, timeoutMs } from '../../config.mjs';
import { serverAuth } from '../../config.mjs';

let browser;

before(async () => {
  browser = await chromium.connect(browsers.playwrightWsEndpoint, { timeout: timeoutMs });
});

after(async () => {
  if (browser) await browser.close();
});

/** Run a callback with a fresh page, always closing it afterwards. */
async function withPage(fn) {
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

describe('remote browser session', () => {
  test('connects and reports a browser version', async () => {
    assert.ok(browser.isConnected(), 'browser should be connected');
    assert.ok(browser.version(), 'expected a browser version string');
  });

  test('can open and close independent pages', async () => {
    const context = await browser.newContext();
    const [a, b] = [await context.newPage(), await context.newPage()];
    assert.equal(context.pages().length, 2);
    await context.close();
  });
});

describe('service reachability', () => {
  for (const [name, base] of Object.entries(browserServices)) {
    test(`${name}: /health loads with a 2xx`, async () => {
      await withPage(async (page) => {
        const response = await page.goto(`${base}/health`, { timeout: timeoutMs });
        assert.ok(response, 'expected a navigation response');
        assert.ok(response.ok(), `expected 2xx, got ${response.status()}`);
        assert.match(await response.text(), /ok/i);
      });
    });
  }

  test('unknown routes surface a 404 to the browser', async () => {
    await withPage(async (page) => {
      const response = await page.goto(`${browserServices.api}/no-such-page-e2e`, {
        timeout: timeoutMs,
      });
      assert.equal(response.status(), 404);
    });
  });
});

describe('in-page JavaScript against the services', () => {
  test('readiness JSON parses inside the browser', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const ready = await page.evaluate(async () => {
        const res = await fetch('/ready');
        return res.json();
      });
      assert.equal(ready.ready, true);
    });
  });

  test('a same-origin POST drives the MCP JSON-RPC endpoint', async () => {
    await withPage(async (page) => {
      // Navigate to the MCP service first so the fetch below is same-origin.
      await page.goto(`${browserServices.mcp}/health`, { timeout: timeoutMs });
      const result = await page.evaluate(async (secret) => {
        const res = await fetch('/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-server-auth': secret },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        return res.json();
      }, serverAuth.secret);
      assert.equal(result.jsonrpc, '2.0');
      assert.equal(result.result.protocolVersion, '2024-11-05');
    });
  });

  test('tools/list is callable from the browser', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.mcp}/health`, { timeout: timeoutMs });
      const tools = await page.evaluate(async (secret) => {
        const res = await fetch('/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-server-auth': secret },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        });
        return (await res.json()).result.tools;
      }, serverAuth.secret);
      assert.ok(Array.isArray(tools) && tools.length > 0, 'expected a non-empty tool list');
    });
  });

  test('the AI server rejects an invalid request from the browser', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.ai}/health`, { timeout: timeoutMs });
      const status = await page.evaluate(async (secret) => {
        const res = await fetch('/api/generate/script', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-server-auth': secret },
          body: JSON.stringify({}),
        });
        return res.status;
      }, serverAuth.secret);
      assert.equal(status, 400);
    });
  });
});

describe('browser diagnostics', () => {
  test('a page against a service records no console errors', async () => {
    await withPage(async (page) => {
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      await page.goto(`${browserServices.web}/health`, { timeout: timeoutMs });
      assert.deepEqual(errors, []);
    });
  });

  test('a screenshot can be captured of a service response', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const shot = await page.screenshot();
      assert.ok(shot.length > 0, 'expected non-empty screenshot bytes');
    });
  });
});
