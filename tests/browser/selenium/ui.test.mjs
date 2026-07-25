// act-web-server operator UI, driven with Selenium WebDriver.
//
// Third driver over the same journeys. WebDriver has no built-in auto-waiting,
// so the explicit waits here are doing real work — a UI that only passes under
// Playwright's auto-waiting has a latent race, and this suite is where it shows.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Builder, By, until } from 'selenium-webdriver';
import { browsers, browserServices, supabase, timeoutMs } from '../../config.mjs';
import { baseClaims, signHs256 } from '../../helpers/jwt.mjs';

const UI = `${browserServices.web}/`;
const testid = (id) => By.css(`[data-testid="${id}"]`);
let driver;

before(async () => {
  driver = await new Builder()
    .usingServer(browsers.seleniumUrl)
    .forBrowser('chrome')
    .build();
  await driver.manage().setTimeouts({ script: timeoutMs, pageLoad: timeoutMs });
});

after(async () => {
  if (driver) await driver.quit();
});

/** Load the UI fresh, clearing any state from the previous scenario. */
async function open() {
  await driver.get(UI);
  await driver.wait(until.elementLocated(testid('identity-form')), timeoutMs);
}

const textOf = async (id) => (await driver.findElement(testid(id)).getText()).trim();

/** Wait until an element is displayed, returning it. */
async function waitShown(id) {
  const el = await driver.wait(until.elementLocated(testid(id)), timeoutMs);
  await driver.wait(until.elementIsVisible(el), timeoutMs);
  return el;
}

/** Poll a testid's text until it satisfies `predicate`. */
function waitText(id, predicate, label) {
  return driver.wait(
    async () => predicate((await textOf(id)) ?? ''),
    timeoutMs,
    `timed out waiting for ${id} to ${label}`,
  );
}

const isHidden = async (id) =>
  !(await driver.findElement(testid(id)).isDisplayed().catch(() => false));

describe('the page renders', () => {
  test('serves HTML with the expected title', async () => {
    await open();
    assert.equal(await driver.getTitle(), 'act-web-server');
    assert.equal(await textOf('title'), 'act-web-server');
  });

  test('renders the form controls', async () => {
    await open();
    for (const id of ['identity-form', 'token-input', 'verify-button']) {
      assert.ok(await driver.findElement(testid(id)), `${id} should exist`);
    }
  });

  test('result and error areas start hidden', async () => {
    await open();
    assert.ok(await isHidden('identity-error'));
    assert.ok(await isHidden('identity-result'));
  });
});

describe('the status panel reflects the live service', () => {
  test('liveness resolves to ok', async () => {
    await open();
    await waitText('health-status', (t) => t === 'ok', 'become ok');
  });

  test('readiness resolves to ready', async () => {
    await open();
    await waitText('ready-status', (t) => t === 'ready', 'become ready');
  });

  test('database state is reported', async () => {
    await open();
    await waitText('database-status', (t) => t !== 'checking…', 'resolve');
    const text = await textOf('database-status');
    assert.ok(['connected', 'not configured'].includes(text), `unexpected: ${text}`);
  });
});

describe('the token form', () => {
  test('submitting an empty form asks for a token', async () => {
    await open();
    await driver.findElement(testid('verify-button')).click();
    await waitShown('identity-error');
    assert.match(await textOf('identity-error'), /enter a token/i);
  });

  test('a malformed token is rejected in the UI', async () => {
    await open();
    await driver.findElement(testid('token-input')).sendKeys('not-a-real-jwt');
    await driver.findElement(testid('verify-button')).click();
    await waitShown('identity-error');
    assert.match(await textOf('identity-error'), /rejected \(401\)|unavailable/i);
    assert.ok(await isHidden('identity-result'), 'must not show an identity');
  });

  test('a valid token renders the verified identity', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await open();
    const token = signHs256(baseClaims({ sub: 'sel-user-3', email: 'sel@example.com' }));
    await driver.findElement(testid('token-input')).sendKeys(token);
    await driver.findElement(testid('verify-button')).click();
    await waitShown('identity-result');
    const shown = JSON.parse(await textOf('identity-result'));
    assert.equal(shown.sub, 'sel-user-3');
    assert.equal(shown.email, 'sel@example.com');
    assert.ok(await isHidden('identity-error'), 'error must be cleared');
  });

  test('an expired token is rejected in the UI', async (t) => {
    if (!supabase.jwtSecret) return t.skip('SUPABASE_JWT_SECRET not set');
    await open();
    const token = signHs256(baseClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    await driver.findElement(testid('token-input')).sendKeys(token);
    await driver.findElement(testid('verify-button')).click();
    await waitShown('identity-error');
    assert.match(await textOf('identity-error'), /401/);
  });

  test('the token is never written into the URL', async () => {
    await open();
    await driver.findElement(testid('token-input')).sendKeys('sensitive-token-value');
    await driver.findElement(testid('verify-button')).click();
    await waitShown('identity-error');
    const url = await driver.getCurrentUrl();
    assert.ok(!url.includes('sensitive-token-value'), `token leaked into ${url}`);
  });
});
