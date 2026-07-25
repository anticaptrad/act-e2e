// Selenium interop: drive a remote Chrome on the cluster's Selenium Grid and
// load the web server's health endpoint through it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from 'selenium-webdriver';
import { browsers, services } from '../../config.mjs';

let driver;

before(async () => {
  driver = await new Builder()
    .usingServer(browsers.seleniumUrl)
    .forBrowser('chrome')
    .build();
});

after(async () => {
  if (driver) await driver.quit();
});

test('web server health endpoint is reachable via Selenium', async () => {
  await driver.get(`${services.web}/health`);
  const source = await driver.getPageSource();
  assert.match(source, /ok/i);
});
