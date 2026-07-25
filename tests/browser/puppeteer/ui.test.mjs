// act-web-server operator UI, driven with Puppeteer.
//
// Same journeys as the Playwright UI suite, through a different driver: the
// point is that the UI behaves identically under both, so a regression that
// only one driver's waiting semantics would surface still gets caught.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { browsers, browserServices, supabase, timeoutMs } from '../../config.mjs';
import { baseClaims, signHs256 } from '../../helpers/jwt.mjs';

const UI = `${browserServices.web}/`;
const testid = (id) => `[data-testid="${id}"]`;
let browser;

before(async () => {
  browser = await puppeteer.connect({ browserWSEndpoint: browsers.puppeteerWsEndpoint });
});

after(async () => {
  if (browser) await browser.disconnect();
});

async function withUi(fn) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(UI);
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** Text of an element, or null when absent. */
const textOf = (page, id) =>
  page.$eval(testid(id), (el) => el.textContent).catch(() => null);

/** Whether an element is present and not hidden. */
const shown = (page, id) =>
  page
    .$eval(testid(id), (el) => !el.hidden && el.offsetParent !== null)
    .catch(() => false);

describe('the page renders', () => {
  test('serves HTML with the expected title', async () => {
    await withUi(async (page) => {
      assert.equal(await page.title(), 'act-web-server');
      assert.equal((await textOf(page, 'title')).trim(), 'act-web-server');
    });
  });

  test('renders the form controls', async () => {
    await withUi(async (page) => {
      for (const id of ['identity-form', 'token-input', 'verify-button']) {
        assert.ok(await page.$(testid(id)), `${id} should exist`);
      }
    });
  });

  test('result and error areas start hidden', async () => {
    await withUi(async (page) => {
      assert.equal(await shown(page, 'identity-error'), false);
      assert.equal(await shown(page, 'identity-result'), false);
    });
  });

  test('the page loads without page errors', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    try {
      await page.goto(UI, { timeout: timeoutMs });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="health-status"]').textContent !== 'checking…',
        { timeout: timeoutMs },
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
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

  test('database state is reported', async () => {
    await withUi(async (page) => {
      await page.waitForFunction(
        () => document.querySelector('[data-testid="database-status"]').textContent !== 'checking…',
        { timeout: timeoutMs },
      );
      const text = (await textOf(page, 'database-status')).trim();
      assert.ok(['connected', 'not configured'].includes(text), `unexpected: ${text}`);
    });
  });
});

describe('the token form', () => {
  test('submitting an empty form asks for a token', async () => {
    await withUi(async (page) => {
      await page.click(testid('verify-button'));
      await page.waitForSelector(testid('identity-error'), { visible: true, timeout: timeoutMs });
      assert.match(await textOf(page, 'identity-error'), /enter a token/i);
    });
  });

  test('a malformed token is rejected in the UI', async () => {
    await withUi(async (page) => {
      await page.type(testid('token-input'), 'not-a-real-jwt');
      await page.click(testid('verify-button'));
      await page.waitForSelector(testid('identity-error'), { visible: true, timeout: timeoutMs });
      assert.match(await textOf(page, 'identity-error'), /rejected \(401\)|unavailable/i);
      assert.equal(await shown(page, 'identity-result'), false);
    });
  });

  test('a valid token renders the verified identity', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await withUi(async (page) => {
      const token = signHs256(baseClaims({ sub: 'pup-user-2', email: 'pup@example.com' }));
      await page.type(testid('token-input'), token);
      await page.click(testid('verify-button'));
      await page.waitForSelector(testid('identity-result'), { visible: true, timeout: timeoutMs });
      const shownJson = JSON.parse(await textOf(page, 'identity-result'));
      assert.equal(shownJson.sub, 'pup-user-2');
      assert.equal(shownJson.email, 'pup@example.com');
      assert.equal(await shown(page, 'identity-error'), false);
    });
  });

  test('an expired token is rejected in the UI', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await withUi(async (page) => {
      const token = signHs256(baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
      await page.type(testid('token-input'), token);
      await page.click(testid('verify-button'));
      await page.waitForSelector(testid('identity-error'), { visible: true, timeout: timeoutMs });
      assert.match(await textOf(page, 'identity-error'), /401/);
    });
  });

  test('the token is never written into the URL', async () => {
    await withUi(async (page) => {
      await page.type(testid('token-input'), 'sensitive-token-value');
      await page.click(testid('verify-button'));
      await page.waitForSelector(testid('identity-error'), { visible: true, timeout: timeoutMs });
      assert.ok(!page.url().includes('sensitive-token-value'), `token leaked into ${page.url()}`);
    });
  });
});
