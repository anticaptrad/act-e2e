// Selenium browser-capability checks.
//
// Proves the WebDriver integration itself works — storage, cookies, window
// management, navigation history, and script execution — so a broken Grid or a
// browser/driver version mismatch is diagnosed as such rather than blamed on
// the services.
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

describe('storage', () => {
  test('localStorage round-trips on a service origin', async () => {
    await driver.get(`${browserServices.api}/health`);
    await driver.executeScript("localStorage.setItem('act-sel', 'stored');");
    const value = await driver.executeScript("return localStorage.getItem('act-sel');");
    assert.equal(value, 'stored');
    await driver.executeScript('localStorage.clear();');
    assert.equal(await driver.executeScript("return localStorage.getItem('act-sel');"), null);
  });

  test('cookies can be added and read back', async () => {
    await driver.get(`${browserServices.api}/health`);
    await driver.manage().addCookie({ name: 'act_sel', value: 'cookie-value', path: '/' });
    const cookie = await driver.manage().getCookie('act_sel');
    assert.equal(cookie.value, 'cookie-value');
  });

  test('cookies can be deleted', async () => {
    await driver.get(`${browserServices.api}/health`);
    await driver.manage().addCookie({ name: 'act_tmp', value: 'x', path: '/' });
    await driver.manage().deleteCookie('act_tmp');
    const cookies = await driver.manage().getCookies();
    assert.equal(cookies.find((c) => c.name === 'act_tmp'), undefined);
  });
});

describe('navigation history', () => {
  test('navigating between services updates the URL', async () => {
    await driver.get(`${browserServices.api}/health`);
    assert.ok((await driver.getCurrentUrl()).startsWith(browserServices.api));
    await driver.get(`${browserServices.web}/health`);
    assert.ok((await driver.getCurrentUrl()).startsWith(browserServices.web));
  });

  test('back and forward traverse the history', async () => {
    await driver.get(`${browserServices.api}/health`);
    await driver.get(`${browserServices.mcp}/health`);
    await driver.navigate().back();
    assert.ok((await driver.getCurrentUrl()).startsWith(browserServices.api));
    await driver.navigate().forward();
    assert.ok((await driver.getCurrentUrl()).startsWith(browserServices.mcp));
  });

  test('refresh reloads the current service', async () => {
    await driver.get(`${browserServices.web}/health`);
    await driver.navigate().refresh();
    assert.match(await driver.getPageSource(), /ok/i);
  });
});

describe('script execution', () => {
  test('a synchronous script returns a value', async () => {
    await driver.get(`${browserServices.api}/health`);
    assert.equal(await driver.executeScript('return 6 * 7;'), 42);
  });

  test('arguments are passed into the page', async () => {
    await driver.get(`${browserServices.api}/health`);
    const result = await driver.executeScript('return arguments[0] + arguments[1];', 'act-', 'e2e');
    assert.equal(result, 'act-e2e');
  });

  test('an async script can await a service call', async () => {
    await driver.get(`${browserServices.mcp}/health`);
    const status = await driver.executeAsyncScript(function (secret) {
      const callback = arguments[arguments.length - 1];
      fetch('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-server-auth': secret },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
        .then((r) => callback(r.status))
        .catch(() => callback(-1));
    }, serverAuth.secret);
    assert.equal(status, 200);
  });

  test('parallel in-page RPCs all succeed', async () => {
    await driver.get(`${browserServices.mcp}/health`);
    const statuses = await driver.executeAsyncScript(function (secret) {
      const callback = arguments[arguments.length - 1];
      const calls = [];
      for (let i = 0; i < 10; i++) {
        calls.push(
          fetch('/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-server-auth': secret },
            body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }),
          }).then((r) => r.status),
        );
      }
      Promise.all(calls).then(callback).catch(() => callback([]));
    }, serverAuth.secret);
    assert.deepEqual(statuses, Array(10).fill(200));
  });
});

describe('window management', () => {
  test('the window can be resized', async () => {
    await driver.get(`${browserServices.api}/health`);
    await driver.manage().window().setRect({ width: 1100, height: 800 });
    const rect = await driver.manage().window().getRect();
    assert.ok(Math.abs(rect.width - 1100) < 50, `unexpected width ${rect.width}`);
  });

  test('the user agent is a real Chrome identity', async () => {
    await driver.get(`${browserServices.api}/health`);
    const ua = await driver.executeScript('return navigator.userAgent;');
    assert.match(ua, /Chrome|Chromium|HeadlessChrome/);
  });

  test('the session survives a sequence of operations', async () => {
    for (const base of Object.values(browserServices)) {
      await driver.get(`${base}/health`);
      assert.match(await driver.getPageSource(), /ok/i);
    }
  });
});
