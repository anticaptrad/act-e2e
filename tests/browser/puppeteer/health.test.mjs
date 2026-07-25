// Puppeteer interop: connect to the cluster's Puppeteer service and hit the API
// server's health endpoint through the remote Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { browsers, services, timeoutMs } from '../../config.mjs';

let browser;

before(async () => {
  browser = await puppeteer.connect({ browserWSEndpoint: browsers.puppeteerWsEndpoint });
});

after(async () => {
  if (browser) await browser.disconnect();
});

test('API server health endpoint responds OK via Puppeteer', async () => {
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${services.api}/health`, { timeout: timeoutMs });
    assert.ok(response, 'expected a navigation response');
    assert.ok(response.status() < 400, `expected < 400, got ${response.status()}`);
    const body = await response.text();
    assert.match(body, /ok/i);
  } finally {
    await page.close();
  }
});
