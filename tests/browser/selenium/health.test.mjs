// Selenium interop: drive a remote Chrome/Chromium on the cluster's Selenium
// Grid and exercise the AntiCapTrad services through it.
//
// WebDriver exposes no response object, so status codes are read by running
// fetch inside the page via executeAsyncScript.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Builder } from 'selenium-webdriver';
import { browsers, browserServices, timeoutMs } from '../../config.mjs';
import { serverAuth } from '../../config.mjs';

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

/**
 * Fetch `path` from inside the currently loaded page (same-origin) and return
 * its status plus parsed body.
 */
function fetchInPage(path, init) {
  return driver.executeAsyncScript(
    function (p, i, secret) {
      const callback = arguments[arguments.length - 1];
      if (i && secret) {
        i.headers = Object.assign({}, i.headers, { 'x-server-auth': secret });
      }
      fetch(p, i || undefined)
        .then((res) => res.text().then((text) => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
          callback({ status: res.status, text: text, json: json });
        }))
        .catch((err) => callback({ status: -1, text: String(err), json: null }));
    },
    path,
    init ?? null,
    serverAuth.secret,
  );
}

describe('remote browser session', () => {
  test('connects to the grid and reports capabilities', async () => {
    const caps = await driver.getCapabilities();
    assert.ok(caps.get('browserName'), 'expected a browserName capability');
    assert.ok(caps.get('browserVersion'), 'expected a browserVersion capability');
  });

  test('can navigate and report the current URL', async () => {
    await driver.get(`${browserServices.web}/health`);
    assert.match(await driver.getCurrentUrl(), /\/health$/);
  });
});

describe('service reachability', () => {
  for (const [name, base] of Object.entries(browserServices)) {
    test(`${name}: /health renders an ok body`, async () => {
      await driver.get(`${base}/health`);
      assert.match(await driver.getPageSource(), /ok/i);
    });
  }

  test('each service reports 200 on /health via in-page fetch', async () => {
    for (const base of Object.values(browserServices)) {
      await driver.get(`${base}/health`);
      const res = await fetchInPage('/health');
      assert.equal(res.status, 200);
      assert.equal(res.json.status, 'ok');
    }
  });

  test('unknown routes report 404 via in-page fetch', async () => {
    await driver.get(`${browserServices.api}/health`);
    const res = await fetchInPage('/not-a-route-e2e');
    assert.equal(res.status, 404);
  });
});

describe('in-page JavaScript against the services', () => {
  test('readiness JSON parses inside the browser', async () => {
    await driver.get(`${browserServices.api}/health`);
    const res = await fetchInPage('/ready');
    assert.equal(res.status, 200);
    assert.equal(res.json.ready, true);
  });

  test('a same-origin POST drives the MCP JSON-RPC endpoint', async () => {
    await driver.get(`${browserServices.mcp}/health`);
    const res = await fetchInPage('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.protocolVersion, '2024-11-05');
  });

  test('an MCP tool call round-trips through the browser', async () => {
    await driver.get(`${browserServices.mcp}/health`);
    const res = await fetchInPage('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'ping', arguments: { message: 'from-selenium' } },
      }),
    });
    assert.equal(res.json.result.content[0].text, 'from-selenium');
  });

  test('an unauthenticated protected route returns 401', async () => {
    await driver.get(`${browserServices.web}/health`);
    const res = await fetchInPage('/api/me');
    assert.equal(res.status, 401);
  });
});

describe('browser diagnostics', () => {
  test('a screenshot can be captured of a service response', async () => {
    await driver.get(`${browserServices.api}/health`);
    const shot = await driver.takeScreenshot();
    assert.ok(shot.length > 0, 'expected non-empty screenshot data');
  });

  test('the document title is retrievable', async () => {
    await driver.get(`${browserServices.web}/health`);
    assert.equal(typeof (await driver.getTitle()), 'string');
  });
});
