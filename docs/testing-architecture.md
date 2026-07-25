# Testing architecture

The suite is layered by *what owns the thing under test*, because that decides
which failures a layer can see at all. A test that talks to an already-running
deployment cannot observe startup or shutdown; a test that owns the process
cannot observe the deployed manifest. Each directory exists for a class of
defect the others structurally cannot catch.

| Layer | Owns | Catches |
| --- | --- | --- |
| `tests/integration/` | nothing — talks to running services | request/response contracts, protocol conformance, auth rejection, security posture |
| `tests/browser/` | a browser session | driver-integration regressions across Playwright, Puppeteer, and Selenium |
| `tests/lifecycle/` | the service process | graceful shutdown, fail-soft startup, fail-closed auth, port config |
| `tests/database/` | a Postgres container | migrations, schema constraints, the service's DB connection path |
| `tests/journeys/` | a service *and* a broker | that the service really consumes what it subscribes to |
| `tests/contracts/` | the k8s manifests on disk | drift between an app default and its deployment |
| `tests/cluster/` | nothing — talks to the deployed cluster | that the *cluster's* shared browser infrastructure works |

Run everything with `npm test`. Run one layer with `npm run test:<layer>`.

## Why the layering matters

Three concrete examples, all of them real defects this repo found:

- **`act-ai-server` crashed at startup when any provider key was absent.** The
  integration layer could never see this: it needs a *running* service to talk
  to, and the bug prevented running. Only `lifecycle/`, which chooses the
  environment and starts the process, could observe it.
- **Shutdown never completed when a client left a response body unread.** Again
  invisible from outside: you have to hold the process handle to know it never
  exited.
- **Supabase JWTs with no `aud` claim authenticated.** This one *was* reachable
  from the integration layer, but only because the auth suite mints deliberately
  malformed tokens. A suite that only signs valid tokens would have passed.

## Design rules

**Skip loudly, never silently.** A layer with an unmet prerequisite reports the
reason (`SKIP no NATS broker at nats://nats:4222`), so a green run with nothing
executed is distinguishable from a green run that tested something. Never let a
missing dependency look like success.

**Derive expectations from the environment.** `ai-provider-matrix` reads
`/ready` to learn which providers hold credentials, then asserts the configured
ones do not report a configuration error and the unconfigured ones do. Hardcoding
either list would make the suite wrong in half the environments it runs in — and
no test spends money on a real model completion.

**Isolate against shared state.** The runner executes files in parallel. The NATS
suites therefore scope subjects under a per-run token; a bare `act.events.>`
subscription would otherwise observe another suite's traffic and fail
intermittently. This is the class of bug that looks like flakiness.

**Prove the suite detects regressions.** Passing tests are weak evidence on their
own. Run the auth suite against a server trusting a different secret: exactly the
four "accepts a valid token" tests fail while all fourteen rejection tests still
pass. If that mutation does not fail, the suite is not testing what it claims.

## Local dependencies

`scripts/local-env.sh` starts NATS, a Selenium Grid, a Playwright server, a CDP
Chromium, and all four services, then prints the environment to export:

```sh
./scripts/local-env.sh up
eval "$(./scripts/local-env.sh env)"
npm test
./scripts/local-env.sh down
```

Services are addressed on `127.0.0.1` for the test process and on the host's LAN
IP for `BROWSER_ACT_*_URL`, because a containerized browser cannot reach the host
on loopback. That distinction is the only reason two sets of URLs exist; in the
cluster they are identical.

## Layers that are not covered here

Running against the deployed clusters — where the browser drivers sit behind an
authenticated scenario API rather than raw endpoints — is documented separately
in [cluster-browser-e2e.md](cluster-browser-e2e.md).
