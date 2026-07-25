# Browser E2E against the deployed clusters

The local browser suites (`tests/browser/`) connect straight to a Playwright
server, a CDP endpoint, and a Selenium Grid. **The deployed clusters do not
expose any of those**, so those suites cannot run against them. This is a
deliberate security decision, not an oversight:

> Only the authenticated Java API is exposed. The Selenium Grid (:4444) stays
> pod-internal so it is never reachable as an unauthenticated remote-control
> endpoint.
> — `remote/argocd/dd-next-runtime/dd-selenium-server.service.yaml`

An open WebDriver or CDP port is a remote-control primitive: anything that can
reach it can drive a browser from inside the cluster, against cluster-internal
addresses. So the clusters put all three drivers behind one authenticated
service instead.

## What the cluster actually offers

`dd-browser-test-server` (port 8104) is a single Fastify service that drives real
Chromium through **all three drivers** behind one declarative scenario API. One
bundled Chromium at `/ms-playwright` backs Playwright and Puppeteer; Selenium
Manager resolves a matching chromedriver on first cold start.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | liveness, plus the serving pod's instance id |
| `GET /tools` | none | driver names and versions |
| `GET /status`, `GET /metrics` | none | diagnostics |
| `POST /run` | `x-server-auth` | run a scenario under a chosen driver |

A scenario names a `tool` and a list of `steps` (`goto`, `click`, `fill`,
`waitForSelector`, `extractText`, `screenshot`, …). The response carries per-step
status, timings, extracted values, and optional screenshots.

`tests/cluster/browser-service.test.mjs` drives that API. It exercises the same
three drivers as the local suites, but through the interface the cluster really
has — which is the only way to prove the deployed browser infrastructure works.

## Running it

The Service is `ClusterIP`, so port-forward it. The **target** URL is resolved by
the remote browser, so it must be an in-cluster address, not `localhost`.

```sh
CTX=dd-ec2-runtime                       # AWS EC2 cluster

kubectl --context "$CTX" -n default port-forward svc/dd-browser-test-server 18104:8104 &

export ACT_BROWSER_TEST_URL=http://127.0.0.1:18104
export ACT_BROWSER_TARGET_URL=http://dd-browser-test-server:8104/healthz
export ACT_BROWSER_TEST_AUTH=$(kubectl --context "$CTX" -n default \
  get secret dd-agent-secrets -o jsonpath='{.data.SERVER_AUTH_SECRET}' | base64 -d)

npm run test:cluster
```

The suite skips with a stated reason when `ACT_BROWSER_TEST_URL` is unset, so it
is safe to leave in a default `npm test` run.

Do not write the secret into a file in the repo tree or echo it into logs. If you
must stage it, use an operator-owned temp path with `umask 077`.

### In-cluster (no port-forward)

`remote/argocd/dd-next-runtime/dd-anticaptrad-e2e-browser-suite.cronjob.yaml` runs
the same suite as a Job, reaching the Service directly and reading the secret from
`dd-agent-secrets`. It is `suspend: true` — the suite briefly drives concurrent
scenarios while `BROWSER_TEST_MAX_CONCURRENT` is 2 per pod, so an unattended
nightly would contend with on-call's smoke harness for shared browser capacity.
Trigger a one-off:

```sh
kubectl -n default create job anticaptrad-e2e-browser-manual \
  --from=cronjob/dd-anticaptrad-e2e-browser-suite
```

## What the suite asserts

- **All three drivers really render.** Each navigates to the target, extracts
  text, and captures a screenshot — a screenshot with bytes proves a renderer
  ran rather than an HTTP fetch having been substituted.
- **The drivers agree.** They differ in API and waiting semantics but must
  observe the same document; a mismatch means one is not loading the target.
- **Auth is enforced.** A run with no header and a run with a wrong secret are
  both rejected, and the rejection does not echo the expected secret.
- **`evaluate` stays refused.** In-page script execution is off by default
  (`BROWSER_TEST_ALLOW_EVALUATE=false`). With it on, a stolen auth header becomes
  a remote-script-execution primitive against cluster-internal URLs. The suite
  fails if it is ever enabled.
- **Load degrades cleanly.** Concurrent scenarios return 200 or 429 — never a
  5xx and never a hang.

The readiness probe on that deployment proves only that the Fastify process is
listening; it never launches a browser. A chromedriver/Chromium version skew, a
Selenium Manager cold-start failure, or an accidentally-enabled `evaluate` would
all pass the probe. That gap is why this lane exists.

## dd-selenium-server

A second, Selenium-only service sits alongside it on port 8105, with the same
`POST /run` contract. It is **one pod with two containers**: `selenium`
(`selenium/standalone-chromium`) runs the real Grid on `:4444`, and
`selenium-api` (Java/Vert.x) drives it over `RemoteWebDriver`. Only the
authenticated API is in the Service; the Grid is never exposed.

That split matters when diagnosing it: the Grid and its API fail independently,
and the Service only routes to the API. A healthy Grid behind a dead API is
still a dead service.

Verified on AWS — a real Grid session renders HTML, waits on a selector, and
extracts text and attributes:

```
goto https://example.com → waitForSelector h1 → extractText → extractAttribute
ok=true  770ms  title='Example Domain'
extracted: {headline: 'Example Domain', link: 'https://iana.org/domains/example'}
screenshot: image/png 16305B
```

## Cluster status observed 2026-07-25

| Cluster | Context / access | Browser infra |
| --- | --- | --- |
| AWS EC2 | `dd-ec2-runtime` | **Healthy.** `dd-browser-test-server` 2/2, `dd-selenium-server` 2/2. All 32 cluster tests pass; Playwright 1.56.0, Puppeteer 24.43.1, Selenium 4.44.0. |
| Hetzner (5-node HA) | SSH `dd-k8s-{fsn1,nbg1,hel1,wrk1,wrk2}` | **Down.** Both services 0/2 for 23+ days; both Service objects have had **zero endpoints for 43 days**. |

On Hetzner the two `dd-selenium-server` containers fail *differently*, which is
the useful detail: the `selenium` Grid container is **Ready, 1 restart, and
actively serving sessions** (Chrome 131.0.6778.204), while `selenium-api` has
**6,645 restarts**. The Grid is fine; the API in front of it cannot start. Since
the Service exposes only the API, the capability is unavailable anyway — a probe
from inside the cluster gets `HTTP 000` on `dd-selenium-server:8105`.

The Hetzner failure is a manifest portability defect, not a capacity problem —
see `k8s-cluster/docs/browser-e2e-cluster-status-2026-07-25.md` for the diagnosis.
Because it is real and unfixed, the cluster suite run against Hetzner fails at
`/healthz`, which is the correct outcome: the infrastructure genuinely is not
serving.
