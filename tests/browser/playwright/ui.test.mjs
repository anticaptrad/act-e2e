// act-web-server operator UI, driven with Playwright.
//
// The other browser suites navigate to JSON endpoints, which proves the driver
// integration but exercises no interface. These drive the actual UI: the status
// panel it populates from /health and /ready, and the token form that calls the
// authenticated /api/me and renders the outcome.
//
// Selectors are `data-testid` attributes so copy and styling can change without
// breaking the suite.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browsers, browserServices, supabase, timeoutMs } from '../../config.mjs';
import { baseClaims, signHs256 } from '../../helpers/jwt.mjs';

const UI = `${browserServices.web}/`;
let browser;

before(async () => {
  browser = await chromium.connect(browsers.playwrightWsEndpoint, { timeout: timeoutMs });
});

after(async () => {
  if (browser) await browser.close();
});

async function withUi(fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(UI, { timeout: timeoutMs });
    return await fn(page);
  } finally {
    await context.close();
  }
}

const testid = (id) => `[data-testid="${id}"]`;

describe('the page renders', () => {
  test('serves HTML with the expected title', async () => {
    await withUi(async (page) => {
      assert.equal(await page.title(), 'act-web-server');
      await page.waitForSelector(testid('title'), { timeout: timeoutMs });
      assert.equal(await page.textContent(testid('title')), 'act-web-server');
    });
  });

  test('renders both panels and the form controls', async () => {
    await withUi(async (page) => {
      for (const id of ['identity-form', 'token-input', 'verify-button']) {
        assert.ok(await page.isVisible(testid(id)), `${id} should be visible`);
      }
    });
  });

  test('result and error areas start hidden', async () => {
    await withUi(async (page) => {
      assert.ok(!(await page.isVisible(testid('identity-error'))));
      assert.ok(!(await page.isVisible(testid('identity-result'))));
    });
  });

  test('the page loads without console errors', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.goto(UI, { timeout: timeoutMs });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="health-status"]').textContent !== 'checking…',
        { timeout: timeoutMs },
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

describe('the status panel reflects the live service', () => {
  test('liveness resolves to ok', async () => {
    await withUi(async (page) => {
      await page.waitForFunction(
        () => document.querySelector('[data-testid="health-status"]').textContent === 'ok',
        { timeout: timeoutMs },
      );
    });
  });

  test('readiness resolves to ready', async () => {
    await withUi(async (page) => {
      await page.waitForFunction(
        () => document.querySelector('[data-testid="ready-status"]').textContent === 'ready',
        { timeout: timeoutMs },
      );
    });
  });

  test('database state is reported, not left checking', async () => {
    await withUi(async (page) => {
      await page.waitForFunction(
        () => document.querySelector('[data-testid="database-status"]').textContent !== 'checking…',
        { timeout: timeoutMs },
      );
      const text = await page.textContent(testid('database-status'));
      assert.ok(
        ['connected', 'not configured'].includes(text),
        `unexpected database status: ${text}`,
      );
    });
  });
});

describe('the token form', () => {
  test('submitting an empty form asks for a token', async () => {
    await withUi(async (page) => {
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-error')}:visible`, { timeout: timeoutMs });
      assert.match(await page.textContent(testid('identity-error')), /enter a token/i);
    });
  });

  test('whitespace alone is treated as empty', async () => {
    await withUi(async (page) => {
      await page.fill(testid('token-input'), '    ');
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-error')}:visible`, { timeout: timeoutMs });
      assert.match(await page.textContent(testid('identity-error')), /enter a token/i);
    });
  });

  test('a malformed token is rejected in the UI', async () => {
    await withUi(async (page) => {
      await page.fill(testid('token-input'), 'not-a-real-jwt');
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-error')}:visible`, { timeout: timeoutMs });
      const text = await page.textContent(testid('identity-error'));
      assert.match(text, /rejected \(401\)|unavailable/i);
      assert.ok(!(await page.isVisible(testid('identity-result'))), 'must not show an identity');
    });
  });

  test('a valid token renders the verified identity', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await withUi(async (page) => {
      const token = signHs256(baseClaims({ sub: 'ui-user-1', email: 'ui@example.com' }));
      await page.fill(testid('token-input'), token);
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-result')}:visible`, { timeout: timeoutMs });
      const shown = JSON.parse(await page.textContent(testid('identity-result')));
      assert.equal(shown.sub, 'ui-user-1');
      assert.equal(shown.email, 'ui@example.com');
      assert.ok(!(await page.isVisible(testid('identity-error'))), 'error must be cleared');
    });
  });

  test('an expired token is rejected in the UI', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await withUi(async (page) => {
      const token = signHs256(baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
      await page.fill(testid('token-input'), token);
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-error')}:visible`, { timeout: timeoutMs });
      assert.match(await page.textContent(testid('identity-error')), /401/);
    });
  });

  test('a rejected attempt after a success clears the previous identity', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await withUi(async (page) => {
      await page.fill(testid('token-input'), signHs256(baseClaims()));
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-result')}:visible`, { timeout: timeoutMs });

      await page.fill(testid('token-input'), 'now-a-bad-token');
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-error')}:visible`, { timeout: timeoutMs });
      assert.ok(
        !(await page.isVisible(testid('identity-result'))),
        'a stale identity must not remain on screen after a rejection',
      );
    });
  });

  test('the token is never written into the URL', async () => {
    // A token in the query string would leak into history, logs, and referers.
    await withUi(async (page) => {
      await page.fill(testid('token-input'), 'sensitive-token-value');
      await page.click(testid('verify-button'));
      await page.waitForSelector(`${testid('identity-error')}:visible`, { timeout: timeoutMs });
      assert.ok(!page.url().includes('sensitive-token-value'), `token leaked into ${page.url()}`);
    });
  });
});
