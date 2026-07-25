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
  browser/                          # same assertions through three drivers
    playwright/  health.test.mjs    # services reached through remote Chromium
                 interaction.test.mjs
    puppeteer/   health.test.mjs    # services reached through remote Chrome (CDP)
                 interaction.test.mjs
    selenium/    health.test.mjs    # services reached through the Grid hub
                 interaction.test.mjs
  integration/
    health.test.mjs                 # probe contracts, readiness payloads, load
    platform-contracts.test.mjs     # conventions that must hold across both stacks
    http-semantics.test.mjs         # methods, paths, content types, body limits
    security.test.mjs               # leakage, fingerprinting, hostile input
    observability.test.mjs          # W3C trace context, correlation headers
    performance.test.mjs            # latency and throughput budgets
    mcp-protocol.test.mjs           # MCP JSON-RPC conformance
    mcp-edge-cases.test.mjs         # transport and envelope corners
    web-auth.test.mjs               # Supabase JWT verification matrix
    web-auth-claims.test.mjs        # claim validation and hardening
    ai-routes.test.mjs              # AI server validation + config errors
    ai-provider-matrix.test.mjs     # every provider, isolation of failures
    nats-bridge.test.mjs            # NATS delivery, scoping, ordering, req/reply
    nats-resilience.test.mjs        # lifecycle, subscriptions, load
  contracts/
    manifests.test.mjs              # k8s manifests vs. what the services do
scripts/
  local-env.sh                      # bring the whole dependency stack up locally
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
npm run test:contracts   # k8s manifests vs. the running services
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

The whole suite runs on a laptop. `scripts/local-env.sh` starts NATS, a Selenium Grid, a Playwright server, a CDP
Chromium, and all four services, then prints the environment to export. Build
the services first (`cargo build` in each `.rs` repo, `npm run build` in
`act-ai-server.ts`).

```sh
./scripts/local-env.sh up          # start everything
eval "$(./scripts/local-env.sh env)"
npm test
./scripts/local-env.sh status      # what is listening
./scripts/local-env.sh down        # stop everything
```

The script addresses services on `127.0.0.1` for the test process and on the
host's LAN IP for `BROWSER_ACT_*_URL`, because the containerized Selenium
browser cannot reach the host on loopback.

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
  ordering, fan-out, queue groups, and request/reply, plus connection lifecycle,
  subscription management, and behaviour under a 2 000-message burst.
- **HTTP semantics** — method handling, path matching (trailing slash, case,
  traversal), content-type enforcement, body limits, and connection reuse.
- **Security** — no stack traces or framework fingerprints in responses, hostile
  input treated as data rather than executed, and secrets never echoed.
- **Observability** — W3C trace context and correlation headers are accepted,
  and a malformed `traceparent` never becomes a 5xx.
- **Manifest contracts** — the act-infra manifests are parsed and checked
  against the running services: probes, resource limits, `securityContext`,
  secret injection, and port agreement. Nothing else fails when an app default
  and its manifest drift apart.

Because the runner executes files in parallel against one broker, the NATS
suites scope their subjects under a per-run token; a bare `act.events.>`
subscription would otherwise observe the other suite's traffic.
