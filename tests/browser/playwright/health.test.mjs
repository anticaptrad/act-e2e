// Playwright interop: drive the remote Chromium in the cluster's Playwright
// service and hit the AI server's health endpoint through it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browsers, services, timeoutMs } from '../../config.mjs';

let browser;

before(async () => {
  browser = await chromium.connect(browsers.playwrightWsEndpoint, { timeout: timeoutMs });
});

after(async () => {
  if (browser) await browser.close();
});

test('AI server health endpoint responds OK via Playwright', async () => {
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${services.ai}/health`, { timeout: timeoutMs });
    assert.ok(response, 'expected a navigation response');
    assert.ok(response.ok(), `expected 2xx, got ${response.status()}`);
    const body = await response.text();
    assert.match(body, /ok/i);
  } finally {
    await page.close();
  }
});
