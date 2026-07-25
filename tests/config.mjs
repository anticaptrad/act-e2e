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
  // Remote Chrome exposed by the Puppeteer service.
  puppeteerWsEndpoint: process.env.PUPPETEER_WS_ENDPOINT ?? 'ws://puppeteer-service:3000',
  // Selenium Grid hub.
  seleniumUrl: process.env.SELENIUM_URL ?? 'http://selenium-hub:4444/wd/hub',
};

// Service URLs. Each k8s Service listens on port 80 and forwards to the app.
export const services = {
  api: process.env.ACT_API_URL ?? 'http://act-api-server',
  web: process.env.ACT_WEB_URL ?? 'http://act-web-server',
  ai: process.env.ACT_AI_URL ?? 'http://act-ai-server',
  mcp: process.env.ACT_MCP_URL ?? 'http://act-mcp-server',
};

export const nats = {
  url: process.env.NATS_URL ?? 'nats://nats:4222',
};

// Per-connection timeout for remote browser sessions (ms).
export const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 30000);
