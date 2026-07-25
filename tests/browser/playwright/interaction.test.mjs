// Playwright browser-capability checks.
//
// health.test.mjs proves the services are reachable through Playwright; this
// file proves the *driver integration* itself works — contexts, storage,
// cookies, concurrency, navigation, and interception — so a broken or
// mismatched Playwright service is caught before a product test blames the app.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browsers, browserServices, timeoutMs } from '../../config.mjs';

let browser;

before(async () => {
  browser = await chromium.connect(browsers.playwrightWsEndpoint, { timeout: timeoutMs });
});

after(async () => {
  if (browser) await browser.close();
});

async function withContext(fn) {
  const context = await browser.newContext();
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}

describe('browser contexts are isolated', () => {
  test('localStorage does not leak between contexts', async () => {
    const url = `${browserServices.api}/health`;
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(url, { timeout: timeoutMs });
      await page.evaluate(() => localStorage.setItem('act-e2e', 'first-context'));
      assert.equal(await page.evaluate(() => localStorage.getItem('act-e2e')), 'first-context');
    });
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(url, { timeout: timeoutMs });
      assert.equal(await page.evaluate(() => localStorage.getItem('act-e2e')), null);
    });
  });

  test('cookies are scoped to their context', async () => {
    const url = new URL(`${browserServices.api}/health`);
    await withContext(async (context) => {
      await context.addCookies([
        { name: 'act_session', value: 'abc123', domain: url.hostname, path: '/' },
      ]);
      const cookies = await context.cookies();
      assert.equal(cookies.find((c) => c.name === 'act_session')?.value, 'abc123');
    });
    await withContext(async (context) => {
      const cookies = await context.cookies();
      assert.equal(cookies.find((c) => c.name === 'act_session'), undefined);
    });
  });

  test('sessionStorage round-trips within a page', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${browserServices.web}/health`, { timeout: timeoutMs });
      await page.evaluate(() => sessionStorage.setItem('k', 'v'));
      assert.equal(await page.evaluate(() => sessionStorage.getItem('k')), 'v');
    });
  });
});

describe('concurrency', () => {
  test('several pages load different services simultaneously', async () => {
    await withContext(async (context) => {
      const targets = Object.values(browserServices);
      const responses = await Promise.all(
        targets.map(async (base) => {
          const page = await context.newPage();
          const res = await page.goto(`${base}/health`, { timeout: timeoutMs });
          return res.status();
        }),
      );
      assert.deepEqual(responses, targets.map(() => 200));
    });
  });

  test('parallel in-page fetches all succeed', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${browserServices.mcp}/health`, { timeout: timeoutMs });
      const statuses = await page.evaluate(async () => {
        const calls = Array.from({ length: 20 }, (_, i) =>
          fetch('/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
          }).then((r) => r.status),
        );
        return Promise.all(calls);
      });
      assert.deepEqual(statuses, Array(20).fill(200));
    });
  });
});

describe('navigation', () => {
  test('navigating between services updates the URL', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      assert.ok(page.url().startsWith(browserServices.api));
      await page.goto(`${browserServices.web}/health`, { timeout: timeoutMs });
      assert.ok(page.url().startsWith(browserServices.web));
    });
  });

  test('reloading a service response works', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const res = await page.reload({ timeout: timeoutMs });
      assert.equal(res.status(), 200);
    });
  });

  test('history navigation returns to the previous service', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      await page.goto(`${browserServices.mcp}/health`, { timeout: timeoutMs });
      await page.goBack({ timeout: timeoutMs });
      assert.ok(page.url().startsWith(browserServices.api));
    });
  });
});

describe('request interception and headers', () => {
  test('a custom header can be injected into service requests', async () => {
    await withContext(async (context) => {
      await context.setExtraHTTPHeaders({ 'x-act-e2e': 'playwright' });
      const page = await context.newPage();
      const res = await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      assert.equal(res.status(), 200, 'service should accept the extra header');
    });
  });

  test('requests can be observed via the network event', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      const urls = [];
      page.on('request', (req) => urls.push(req.url()));
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      assert.ok(urls.some((u) => u.includes('/health')), 'expected to observe the request');
    });
  });

  test('a route can be aborted without breaking the browser', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.route('**/blocked', (route) => route.abort());
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const blocked = await page.evaluate(async () => {
        try {
          await fetch('/blocked');
          return 'not-blocked';
        } catch {
          return 'blocked';
        }
      });
      assert.equal(blocked, 'blocked');
    });
  });
});

describe('viewport and environment', () => {
  test('the viewport can be configured', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const size = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
      }));
      assert.equal(size.w, 1280);
      assert.equal(size.h, 720);
    } finally {
      await context.close();
    }
  });

  test('the user agent is a real Chromium identity', async () => {
    await withContext(async (context) => {
      const page = await context.newPage();
      await page.goto(`${browserServices.api}/health`, { timeout: timeoutMs });
      const ua = await page.evaluate(() => navigator.userAgent);
      assert.match(ua, /Chrome|Chromium|HeadlessChrome/);
    });
  });
});
