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

## Cluster status observed 2026-07-25

| Cluster | Context / access | Browser infra |
| --- | --- | --- |
| AWS EC2 | `dd-ec2-runtime` | **Healthy.** `dd-browser-test-server` 2/2, `dd-selenium-server` 2/2. All 32 cluster tests pass; Playwright 1.56.0, Puppeteer 24.43.1, Selenium 4.44.0. |
| Hetzner (5-node HA) | SSH `dd-k8s-{fsn1,nbg1,hel1,wrk1,wrk2}` | **Down.** `dd-browser-test-server` and `dd-selenium-server` 0/2, crash-looping for 23+ days. |

The Hetzner failure is a manifest portability defect, not a capacity problem —
see `k8s-cluster/docs/browser-e2e-cluster-status-2026-07-25.md` for the diagnosis.
Because it is real and unfixed, the cluster suite run against Hetzner fails at
`/healthz`, which is the correct outcome: the infrastructure genuinely is not
serving.
