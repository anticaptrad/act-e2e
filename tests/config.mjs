// Shared endpoint configuration for the e2e suites.
//
// Defaults target in-cluster DNS names (~/codes/ores/k8s-cluster): the shared
// Playwright / Puppeteer / Selenium services and the NATS bridge, plus the
// AntiCapTrad service Services (each fronts its pods on port 80). Every value is
// overridable via environment variable so the same tests run from a laptop
// against port-forwarded endpoints.

export const browsers = {
  // Remote Chromium exposed by the Playwright service.
  playwrightWsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://playwright-service:3000',
  // Remote Chrome exposed by the Puppeteer service (CDP endpoint).
  puppeteerWsEndpoint: process.env.PUPPETEER_WS_ENDPOINT ?? 'ws://puppeteer-service:3000',
  // Selenium Grid hub.
  seleniumUrl: process.env.SELENIUM_URL ?? 'http://selenium-hub:4444/wd/hub',
};

// Service URLs as seen from the test process. Each k8s Service listens on port
// 80 and forwards to the app.
export const services = {
  api: process.env.ACT_API_URL ?? 'http://act-api-server',
  web: process.env.ACT_WEB_URL ?? 'http://act-web-server',
  ai: process.env.ACT_AI_URL ?? 'http://act-ai-server',
  mcp: process.env.ACT_MCP_URL ?? 'http://act-mcp-server',
};

// Service URLs as seen *from inside a remote browser*. In-cluster these are the
// same as `services`, so they default to it. They differ only when driving a
// containerized browser from the host during local testing, where the host is
// reachable under another name (e.g. `host.docker.internal`).
export const browserServices = {
  api: process.env.BROWSER_ACT_API_URL ?? services.api,
  web: process.env.BROWSER_ACT_WEB_URL ?? services.web,
  ai: process.env.BROWSER_ACT_AI_URL ?? services.ai,
  mcp: process.env.BROWSER_ACT_MCP_URL ?? services.mcp,
};

export const nats = {
  url: process.env.NATS_URL ?? 'nats://nats:4222',
};

// Supabase JWT settings. The secret is only known to the test process when
// explicitly provided; auth suites skip themselves when it is absent so the
// suite stays runnable against an environment whose secret we don't hold.
export const supabase = {
  jwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
  jwtAud: process.env.SUPABASE_JWT_AUD ?? 'authenticated',
};

// The cluster's shared browser-automation service (dd-browser-test-server).
//
// Unlike the local suites, this is not a raw Playwright/CDP/WebDriver endpoint:
// the cluster deliberately keeps those pod-internal and exposes one
// authenticated scenario API instead (`POST /run` with a `tool` field). See
// docs/cluster-browser-e2e.md.
//
// `baseUrl` is normally a port-forward to the in-cluster Service. `targetUrl` is
// what the remote browser should navigate to, so it must resolve *inside* the
// cluster — hence the in-cluster DNS default.
export const clusterBrowser = {
  baseUrl: process.env.ACT_BROWSER_TEST_URL ?? '',
  authSecret: process.env.ACT_BROWSER_TEST_AUTH ?? '',
  targetUrl:
    process.env.ACT_BROWSER_TARGET_URL ?? 'http://dd-browser-test-server:8104/healthz',
  // Scenario runs drive a real browser; they need far longer than an HTTP probe.
  timeoutMs: Number(process.env.ACT_BROWSER_TEST_TIMEOUT_MS ?? 180_000),
};


// The cluster's MCP servers (~/codes/ores/k8s-cluster), reached through the
// dd-remote-gateway. Each is a JSON-RPC MCP endpoint behind bearer auth; the
// read-only pair share one token while the browser server has its own.
// See docs/cluster-mcp.md.
export const clusterMcp = {
  baseUrl: process.env.ACT_MCP_GATEWAY_URL ?? '',
  /** Token for the read-only servers (/cluster-mcp, /mcp). */
  token: process.env.ACT_MCP_TOKEN ?? '',
  /** dd-browser-mcp-rs uses a separate secret. */
  browserToken: process.env.ACT_BROWSER_MCP_TOKEN ?? '',
  /** Allow a self-signed gateway certificate (the IP-based endpoint has one). */
  insecureTls: process.env.ACT_MCP_INSECURE_TLS === 'true',
  timeoutMs: Number(process.env.ACT_MCP_TIMEOUT_MS ?? 30_000),
};

// Shared secret guarding the services' /api and /mcp surfaces. Attached
// automatically by the HTTP helpers when set, so every suite authenticates
// without threading a header through each call.
export const serverAuth = {
  secret: process.env.ACT_SERVER_AUTH_SECRET ?? '',
};

// Per-connection timeout for remote browser sessions and HTTP calls (ms).
export const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 30000);
