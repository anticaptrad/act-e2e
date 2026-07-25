# act-e2e

End-to-end interop tests for the AntiCapTrad platform. They exercise the
deployed services (`act-api-server`, `act-web-server`, `act-ai-server`,
`act-mcp-server`) through the shared browser automation services and the NATS
bridge running in the k8s cluster at `~/codes/ores/k8s-cluster`.

Tests are plain ESM (`*.test.mjs`) run by the Node built-in test runner — no
transpiler, no jest.

## Layout

```
tests/
  config.mjs                       # endpoints, overridable via env
  browser/
    playwright/health.test.mjs     # remote Chromium via the Playwright service
    puppeteer/health.test.mjs      # remote Chrome via the Puppeteer service
    selenium/health.test.mjs       # remote Chrome via the Selenium Grid hub
  integration/
    health.test.mjs                # direct HTTP health/readiness sweep + MCP JSON-RPC
    nats-bridge.test.mjs           # publish/subscribe round-trip over the NATS bridge
```

## Running

```sh
npm install
npm test                 # all suites
npm run test:playwright  # one runner at a time
npm run test:integration
```

These target in-cluster DNS by default, so run them from inside the cluster (or
a job) — or point them at port-forwarded endpoints:

| Env var | Default |
| --- | --- |
| `PLAYWRIGHT_WS_ENDPOINT` | `ws://playwright-service:3000` |
| `PUPPETEER_WS_ENDPOINT` | `ws://puppeteer-service:3000` |
| `SELENIUM_URL` | `http://selenium-hub:4444/wd/hub` |
| `NATS_URL` | `nats://nats:4222` |
| `ACT_API_URL` / `ACT_WEB_URL` / `ACT_AI_URL` / `ACT_MCP_URL` | `http://act-<svc>` |
| `E2E_TIMEOUT_MS` | `30000` |
