# Talking to the cluster's MCP servers

The Kubernetes cluster at `~/codes/ores/k8s-cluster` runs three MCP endpoints
behind the `dd-remote-gateway`. `tests/cluster/mcp-servers.test.mjs` asserts they
are reachable and still speak the protocol we expect — without it, a revoked
token, a changed gateway route, or a crash-looping upstream stays invisible
until someone tries one by hand.

## The endpoints

| Server | Gateway path | Auth | Surface |
| --- | --- | --- | --- |
| `dd-cluster-mcp-rs` | `/cluster-mcp` | `DD_MCP_TOKEN` | 20 read-only tools: cluster/service inventory, deployments, ingress, events, telemetry, Cloudflare/RDAP |
| `dd-browser-mcp-rs` | `/browser-mcp` | **its own** `BROWSER_MCP_AUTH_SECRET` | `browser_act`, `browser_observe` |
| `dd-gleam-mcp-server` | `/mcp` | `DD_MCP_TOKEN` | — |

The two read-only servers share `DD_MCP_TOKEN` (the same one `.mcp.json` uses,
read from `~/.dd-mcp-token`). **The browser server does not** — it has a separate
secret, and presenting the read-only token gets a `-32001 unauthorized`. The
suite pins that separation so the two never silently converge.

## Running the suite

```sh
export ACT_MCP_GATEWAY_URL=https://98.90.186.114
export ACT_MCP_TOKEN="$(cat ~/.dd-mcp-token)"
export ACT_BROWSER_MCP_TOKEN="$(kubectl --context dd-ec2-runtime -n default \
  get secret dd-browser-mcp-rs-secrets \
  -o jsonpath='{.data.BROWSER_MCP_AUTH_SECRET}' | base64 -d)"
export ACT_MCP_INSECURE_TLS=true   # gateway is reached by IP; cert will not match

npm run test:cluster
```

`ACT_MCP_INSECURE_TLS` is opt-in and scoped to that module — the endpoint is an
IP address, so its certificate cannot match. Do not set it as a default.

The suite skips with a stated reason when `ACT_MCP_GATEWAY_URL` is unset, so it
is safe to leave in a default `npm test` run.

## What it asserts

- The MCP handshake completes and the server identifies itself with a protocol
  version.
- `tools/list` returns a non-empty list and every tool carries an `inputSchema`.
- An **unauthenticated** call is refused, and the refusal does not echo the
  expected token back.
- `dd-cluster-mcp` still exposes the tools we depend on (`cluster_status`,
  `service_directory`, `kubernetes_deployments`), a real tool call returns MCP
  content blocks, and an unknown tool is an error rather than a silent success.
- `dd-browser-mcp` advertises `browser_act`/`browser_observe` and rejects the
  read-only token.

## Status observed 2026-07-25

| Server | State |
| --- | --- |
| `dd-cluster-mcp-rs` | **Healthy.** Protocol `2025-11-25`, 20 tools. |
| `dd-browser-mcp-rs` | **Healthy.** 2 tools. |
| `dd-gleam-mcp-server` | **Down.** `/mcp` returns 502. |

`dd-gleam-mcp-server` fails in its `build-gleam-mcp-server` init container —
exit 1, **412 restarts** over ~2 days, with a backlog of evicted pods. The suite
reports it and skips rather than failing the run, because it is an upstream
outage this repo neither caused nor owns. Flip `required: true` for that entry in
the suite once it is fixed, so a regression fails loudly.

Two cluster-side notes worth fixing there rather than here:

- `dd-browser-mcp-rs` is **not listed in `k8s-cluster/.mcp.json`**, so editors
  configured from that file cannot reach it even though the gateway routes it.
- The gateway config describes `/browser-mcp` as "DELIBERATELY PUBLIC … while
  `REQUIRE_AUTH=false`", but the deployment sets `BROWSER_MCP_REQUIRE_AUTH=true`.
  The comment is stale; the endpoint does require auth.
