# act-e2e

End-to-end tests for the AntiCapTrad platform. They exercise the deployed
services (`act-api-server`, `act-web-server`, `act-ai-server`, `act-mcp-server`)
through the shared browser automation services and the NATS bridge running in
the k8s cluster at `~/codes/ores/k8s-cluster`.

Tests are plain ESM (`*.test.mjs`) run by the Node built-in test runner — no
transpiler, no jest.

**Docs:** [testing-architecture.md](docs/testing-architecture.md) explains the
layering and why each layer exists; [cluster-browser-e2e.md](docs/cluster-browser-e2e.md)
covers running browser E2E against the deployed AWS and Hetzner clusters.

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
                 ui.test.mjs        # the act-web-server operator UI
    puppeteer/   health.test.mjs    # services reached through remote Chrome (CDP)
                 interaction.test.mjs
                 ui.test.mjs
    selenium/    health.test.mjs    # services reached through the Grid hub
                 interaction.test.mjs
                 ui.test.mjs
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
    ai-publish.test.mjs             # YouTube publishing + upload-dir containment
    ai-provider-matrix.test.mjs     # every provider, isolation of failures
    nats-bridge.test.mjs            # NATS delivery, scoping, ordering, req/reply
    nats-resilience.test.mjs        # lifecycle, subscriptions, load
  lifecycle/                        # owns the process under test
    shutdown.test.mjs               # SIGTERM draining and bounded exit
    config-matrix.test.mjs          # fail-soft deps, fail-closed auth, ports
  database/
    migrations.test.mjs             # sea-orm migrations against real Postgres
  journeys/
    event-bridge.test.mjs           # the api-server really consumes NATS events
  contracts/
    manifests.test.mjs              # k8s manifests vs. what the services do
  cluster/
    browser-service.test.mjs        # the deployed cluster's browser service
    mcp-servers.test.mjs            # the cluster's MCP endpoints
docs/
  testing-architecture.md           # why the layering exists
  cluster-browser-e2e.md            # running against AWS / Hetzner
  cluster-mcp.md                    # talking to the cluster's MCP servers
scripts/
  local-env.sh                      # bring the whole dependency stack up locally
```

Each browser suite drives the same services through a different automation
stack, so a regression in any one driver integration is caught independently.
The `ui.test.mjs` files drive `act-web-server`'s operator UI — the status panel
and the token-verification form — through all three drivers. Selenium has no
auto-waiting, so a UI that only passes under Playwright has a latent race and
that suite is where it surfaces.

## Running

```sh
npm install
npm test                 # everything
npm run test:apps-script # public Google Apps Script contracts; no secrets
npm run test:integration # HTTP + NATS suites only (no browser needed)
npm run test:browser     # all three browser drivers
npm run test:playwright  # one driver at a time
npm run test:contracts   # k8s manifests vs. the running services
npm run test:lifecycle   # shutdown + startup config (spawns its own services)
npm run test:database    # migrations (starts its own Postgres via docker)
npm run test:journeys    # cross-service flows
npm run test:cluster     # the deployed cluster's browser service (see docs/)
```

The `lifecycle`, `database`, and `journeys` suites start what they need rather
than talking to an existing deployment, because the behaviour under test *is*
the startup and shutdown path. They need the services built alongside this repo
(and docker, for `database`), and skip with an explicit reason otherwise — a
skipped suite names the missing prerequisite rather than passing silently.

Endpoints default to in-cluster DNS, so run from inside the cluster (or a Job) —
or point them at port-forwarded endpoints:

| Env var | Default |
| --- | --- |
| `PLAYWRIGHT_WS_ENDPOINT` | `ws://playwright-service:3000` |
| `PUPPETEER_WS_ENDPOINT` | `ws://puppeteer-service:3000` |
| `SELENIUM_URL` | `http://selenium-hub:4444/wd/hub` |
| `NATS_URL` | `nats://nats:4222` |
| `ACT_API_URL` / `ACT_WEB_URL` / `ACT_AI_URL` / `ACT_MCP_URL` | `http://act-<svc>` |
| `YOUTUBE_GAS_URL` | Anticaptrad YouTube Apps Script deployment |
| `CHAT_BRIDGE_GAS_URL` | Google Chat bridge Apps Script deployment |
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

The Apps Script smoke suite never reads an API key or bridge token. It checks
the public health and landing-page contracts, then sends deliberately
unauthenticated requests to prove privileged routes fail closed without leaking
stack traces. The separate YouTube lifecycle commands use explicitly selected
SOPS ciphertext from `env/enc/`; plaintext may exist only in the command
environment or ignored, mode-`0600` files under `env/dec/`.

## Three-minute YouTube lifecycle proof

The default lifecycle fixture is original, synthetic, silent, text-only, and
reviewed as PG-13 safe. It is exactly 180 seconds, 1280x720 H.264/AAC, and
capped below the Apps Script bridge's 8 MiB ingest limit. It makes no
third-party factual, music, footage, voice, or likeness claim. A real creator
render can replace the synthetic fixture by setting
`YOUTUBE_E2E_RENDER_RECEIPT_PATH` to the credential-free receipt emitted by
`act-render`; that enables a strict pre-network gate which requires an approved
native render and matches the master output's SHA-256, byte size, and reviewed
duration to the local upload file.

The flow is private first and split into independent safety gates:

1. Generate and probe the local fixture with FFmpeg, or render the reviewed
   creator project and retain its native render receipt.
2. When a render receipt is configured, verify its closed schema, renderer,
   review state, publication eligibility, exact channel, and output integrity
   before making any bridge request.
3. Verify the Apps Script deployment and the pinned `@anticaptrad` channel ID.
4. Send the bytes through the authenticated `ingestVideo` action with a SHA-256
   digest and deterministic correlation ID; Apps Script stores them in Drive.
5. Start and process the existing resumable YouTube upload, which always begins
   private.
6. Read the channel's recent videos and verify the resulting video is private.
7. Review playback, metadata, rights, and channel identity manually.
8. Perform a separate public transition that requires both an explicit local
   opt-in and the Apps Script phrase `PUBLISH VIDEO_ID AS PUBLIC`.

After `anticaptrad@gmail.com` access is restored, rotate/capture the Apps Script
API key and put these values into `env/enc/dev.env.enc` and
`env/enc/prod.env.enc` with `just env-edit`; never paste them into source,
commands, URLs, logs, or CI output:

- `YOUTUBE_GAS_URL`
- `YOUTUBE_GAS_API_KEY`
- `YOUTUBE_GAS_EXPECTED_CHANNEL_HANDLE=@anticaptrad`
- `YOUTUBE_GAS_EXPECTED_CHANNEL_ID`

For a native creator render, also set `YOUTUBE_E2E_VIDEO_PATH` to the master
MP4 and `YOUTUBE_E2E_RENDER_RECEIPT_PATH` to its `act-render` receipt. The
receipt is not a secret and must not contain credentials or media bytes, but its
path belongs in the selected environment so the upload gate is explicit.

Then run:

```sh
nix develop ./.nix
just env-check
just youtube-fixture
just youtube-preflight dev
just youtube-upload-private dev
# Review the private video and its receipt under tmp/youtube-lifecycle/.
just youtube-publish prod VIDEO_ID
```

The publication approval is intentionally ephemeral and is not stored in SOPS.
The final recipe constructs it from the reviewed public video ID. While the
Google account is frozen, only fixture generation, local tests, public health,
and fail-closed unauthenticated checks are permitted; the tooling does not try
to bypass Google's account review.

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
- **Lifecycle** — SIGTERM drains in-flight work and exits 0, and the drain is
  *bounded*: a client that never reads its response body keeps the connection
  active, which would otherwise hold the pod open until the kubelet SIGKILLed it
  and stall every rolling update.
- **Startup configuration** — optional dependencies fail soft (a dead broker or
  database still serves probes) while auth fails closed (no signing secret means
  deny, never allow). Audience, issuer, and leeway are checked as configured.
- **Migrations** — the sea-orm crate is applied to a throwaway Postgres: schema
  shape, NOT NULL and primary-key constraints, `status`, idempotent re-runs, and
  a reversible `down`. This is also the only place the service's database
  connection path is exercised at all; every other suite runs without one.
- **Event-bridge journey** — proves the api-server *itself* consumes what it
  subscribes to. The NATS suites only show the broker delivers to a subscriber
  we control, which would still pass if the service were subscribed to the wrong
  subject or silently failing.
- **Manifest contracts** — the act-infra manifests are parsed and checked
  against the running services: probes, resource limits, `securityContext`,
  secret injection, and port agreement. Nothing else fails when an app default
  and its manifest drift apart.

Because the runner executes files in parallel against one broker, the NATS
suites scope their subjects under a per-run token; a bare `act.events.>`
subscription would otherwise observe the other suite's traffic.
