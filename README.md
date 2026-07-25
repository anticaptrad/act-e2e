# act-e2e

End-to-end tests for the AntiCapTrad platform. They exercise the deployed
services (`act-api-server`, `act-web-server`, `act-ai-server`, `act-mcp-server`)
through the shared browser automation services and the NATS bridge running in
the k8s cluster at `~/codes/ores/k8s-cluster`.

Tests are plain ESM (`*.test.mjs`) run by the Node built-in test runner — no
transpiler, no jest.

## Layout

```
tests/
  config.mjs                        # endpoints, overridable via env
  helpers/
    http.mjs                        # fetch + JSON-RPC helpers
    jwt.mjs                         # HS256 minting, incl. deliberately bad tokens
  browser/
    playwright/health.test.mjs      # remote Chromium via the Playwright service
    puppeteer/health.test.mjs       # remote Chrome via the Puppeteer service (CDP)
    selenium/health.test.mjs        # remote Chrome via the Selenium Grid hub
  integration/
    health.test.mjs                 # probe contracts, readiness payloads, load
    mcp-protocol.test.mjs           # MCP JSON-RPC conformance
    web-auth.test.mjs               # Supabase JWT verification matrix
    ai-routes.test.mjs              # AI server validation + config errors
    nats-bridge.test.mjs            # NATS delivery, scoping, ordering, req/reply
```

Each browser suite drives the same services through a different automation
stack, so a regression in any one driver integration is caught independently.

## Running

```sh
npm install
npm test                 # everything
npm run test:integration # HTTP + NATS suites only (no browser needed)
npm run test:browser     # all three browser drivers
npm run test:playwright  # one driver at a time
```

Endpoints default to in-cluster DNS, so run from inside the cluster (or a Job) —
or point them at port-forwarded endpoints:

| Env var | Default |
| --- | --- |
| `PLAYWRIGHT_WS_ENDPOINT` | `ws://playwright-service:3000` |
| `PUPPETEER_WS_ENDPOINT` | `ws://puppeteer-service:3000` |
| `SELENIUM_URL` | `http://selenium-hub:4444/wd/hub` |
| `NATS_URL` | `nats://nats:4222` |
| `ACT_API_URL` / `ACT_WEB_URL` / `ACT_AI_URL` / `ACT_MCP_URL` | `http://act-<svc>` |
| `BROWSER_ACT_*_URL` | same as `ACT_*_URL` |
| `SUPABASE_JWT_SECRET` | *(unset — auth suite skips)* |
| `SUPABASE_JWT_AUD` | `authenticated` |
| `E2E_TIMEOUT_MS` | `30000` |

Two knobs need explanation:

- **`BROWSER_ACT_*_URL`** is how a *remote browser* reaches a service. In-cluster
  it equals `ACT_*_URL`, so it is only set when the browser sits in a different
  network namespace than the test process (see the local recipe below).
- **`SUPABASE_JWT_SECRET`** must match the server under test for the auth suite
  to mint valid tokens. The suite skips itself when the secret is unset, so the
  rest of the tests stay runnable against an environment whose secret you do not
  hold.

## Running locally against real dependencies

The whole suite runs on a laptop. Because the containerized Selenium browser
cannot reach the host on `127.0.0.1`, address the services by the host's LAN IP —
reachable from both the host and the containers.

```sh
LAN=$(ipconfig getifaddr en0)          # macOS; use `hostname -I` on Linux

# Dependencies
docker run -d --name nats -p 4222:4222 nats:2-alpine
docker run -d --name selenium --shm-size=2g -p 4444:4444 selenium/standalone-chromium

# Playwright server + a CDP browser for Puppeteer
npx playwright install chromium
npx playwright run-server --port 3100 --host 127.0.0.1 &
"$(find ~/Library/Caches/ms-playwright -name headless_shell | head -1)" \
  --remote-debugging-port=9222 --headless &

# Services (from their own repos): act_api_server, act_web_server,
# act_mcp_server on 8080/8081/8082 and act-ai-server on 3000.

npm test
```

Set `ACT_*_URL` to `http://127.0.0.1:<port>` and `BROWSER_ACT_*_URL` to
`http://$LAN:<port>`, plus the browser endpoints and `SUPABASE_JWT_SECRET`.

## What the suites assert

- **Probe contracts** — every service serves `/health` and `/ready` as JSON,
  without credentials, and 404s unknown routes. Readiness reports dependency
  state (NATS, Postgres, configured LLM providers) but never *gates* on it, so a
  dependency outage cannot cascade into a rolling restart.
- **MCP protocol** — handshake, tool catalog, tool invocation, JSON-RPC error
  codes (`-32601`, `-32602`), id echoing, and the notification rule (no `id` ⇒
  `202` with an empty body).
- **Auth** — the full rejection matrix (missing, malformed, expired, wrong
  signature, wrong audience, tampered payload, non-Bearer scheme) plus a forged
  `alg: none` token, which must be rejected or auth is bypassable. Public probes
  must stay open.
- **AI routes** — request validation and the configuration-error path. Which
  providers are configured is read from `/ready`, so the suite adapts to whatever
  credentials the environment holds instead of hardcoding them. No test spends
  money on a real completion.
- **NATS** — delivery over `act.events.>` (the subject the api-server consumes),
  subject scoping, payload integrity (JSON, unicode, empty, 64 KiB, headers),
  ordering, fan-out, queue groups, and request/reply.
