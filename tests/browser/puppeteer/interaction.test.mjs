// Puppeteer browser-capability checks.
//
// Proves the CDP driver integration itself works — storage, cookies,
// concurrency, navigation, interception — independently of whether the services
// behave, so a broken Puppeteer service is diagnosed as such.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { browsers, browserServices, timeoutMs } from '../../config.mjs';
import { serverAuth } from '../../config.mjs';

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

describe('storage', () => {
  test('localStorage round-trips on a service origin', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`);
      await page.evaluate(() => localStorage.setItem('act-pup', 'stored'));
      assert.equal(await page.evaluate(() => localStorage.getItem('act-pup')), 'stored');
      await page.evaluate(() => localStorage.clear());
      assert.equal(await page.evaluate(() => localStorage.getItem('act-pup')), null);
    });
  });

  test('cookies can be set and read back', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`);
      await page.setCookie({ name: 'act_pup', value: 'cookie-value', path: '/' });
      const cookies = await page.cookies();
      assert.equal(cookies.find((c) => c.name === 'act_pup')?.value, 'cookie-value');
    });
  });

  test('sessionStorage is per-page', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.web}/health`);
      await page.evaluate(() => sessionStorage.setItem('s', '1'));
      assert.equal(await page.evaluate(() => sessionStorage.getItem('s')), '1');
    });
  });
});

describe('concurrency', () => {
  test('several pages hit different services at once', async () => {
    const targets = Object.values(browserServices);
    const pages = await Promise.all(targets.map(() => browser.newPage()));
    try {
      const statuses = await Promise.all(
        pages.map(async (page, i) => {
          const res = await page.goto(`${targets[i]}/health`, { timeout: timeoutMs });
          return res.status();
        }),
      );
      assert.deepEqual(statuses, targets.map(() => 200));
    } finally {
      await Promise.all(pages.map((p) => p.close()));
    }
  });

  test('parallel in-page RPCs all succeed', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.mcp}/health`);
      const ids = await page.evaluate(async (secret) => {
        const calls = Array.from({ length: 15 }, (_, i) =>
          fetch('/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-server-auth': secret },
            body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
          })
            .then((r) => r.json())
            .then((j) => j.id),
        );
        return Promise.all(calls);
      }, serverAuth.secret);
      assert.deepEqual(ids, Array.from({ length: 15 }, (_, i) => i));
    });
  });
});

describe('navigation', () => {
  test('navigating between services updates the URL', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`);
      assert.ok(page.url().startsWith(browserServices.api));
      await page.goto(`${browserServices.mcp}/health`);
      assert.ok(page.url().startsWith(browserServices.mcp));
    });
  });

  test('reload returns the same result', async () => {
    await withPage(async (page) => {
      const first = await page.goto(`${browserServices.api}/health`);
      const second = await page.reload();
      assert.equal(first.status(), second.status());
    });
  });

  test('going back restores the previous service', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`);
      await page.goto(`${browserServices.web}/health`);
      await page.goBack();
      assert.ok(page.url().startsWith(browserServices.api));
    });
  });
});

describe('interception', () => {
  test('extra HTTP headers are accepted by the services', async () => {
    await withPage(async (page) => {
      await page.setExtraHTTPHeaders({ 'x-act-e2e': 'puppeteer' });
      const res = await page.goto(`${browserServices.api}/health`);
      assert.equal(res.status(), 200);
    });
  });

  test('request interception can block a URL', async () => {
    await withPage(async (page) => {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().includes('/blocked')) req.abort();
        else req.continue();
      });
      await page.goto(`${browserServices.api}/health`);
      const outcome = await page.evaluate(async () => {
        try {
          await fetch('/blocked');
          return 'not-blocked';
        } catch {
          return 'blocked';
        }
      });
      assert.equal(outcome, 'blocked');
    });
  });

  test('responses are observable through the network event', async () => {
    await withPage(async (page) => {
      const seen = [];
      page.on('response', (res) => seen.push(res.status()));
      await page.goto(`${browserServices.api}/health`);
      assert.ok(seen.includes(200), 'expected to observe a 200 response');
    });
  });
});

describe('environment', () => {
  test('the viewport can be resized', async () => {
    await withPage(async (page) => {
      await page.setViewport({ width: 1024, height: 768 });
      await page.goto(`${browserServices.api}/health`);
      const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      assert.equal(size.w, 1024);
      assert.equal(size.h, 768);
    });
  });

  test('the user agent is a real Chrome identity', async () => {
    await withPage(async (page) => {
      await page.goto(`${browserServices.api}/health`);
      const ua = await page.evaluate(() => navigator.userAgent);
      assert.match(ua, /Chrome|Chromium|HeadlessChrome/);
    });
  });
});
