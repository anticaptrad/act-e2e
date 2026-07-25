// Launch a service under test with a controlled environment.
//
// Most suites talk to an already-running deployment. Lifecycle behaviour —
// graceful shutdown, fail-soft startup, fail-closed auth — can only be observed
// by owning the process, so these helpers start a service on an ephemeral port
// and hand back a handle.
//
// They require the built binaries alongside this repo; suites that use them
// skip when the binary is absent.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIBLINGS = process.env.ACT_REPOS_PATH ?? path.resolve(here, '../../..');

/** Built artifacts for each service, relative to the sibling repo root. */
export const BINARIES = {
  api: path.join(SIBLINGS, 'act-api-server.rs/target/debug/act_api_server'),
  web: path.join(SIBLINGS, 'act-web-server.rs/target/debug/act_web_server'),
  mcp: path.join(SIBLINGS, 'act-mcp-server.rs/target/debug/act_mcp_server'),
  ai: path.join(SIBLINGS, 'act-ai-server.ts/dist/index.js'),
};

export const hasBinary = (name) => fs.existsSync(BINARIES[name]);

/** Reason string for skipping, or false when the binary is present. */
export function skipUnlessBuilt(...names) {
  const missing = names.filter((n) => !hasBinary(n));
  return missing.length === 0
    ? false
    : `not built: ${missing.map((n) => BINARIES[n]).join(', ')}`;
}

/** Ask the OS for a free TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (text) => text.replace(ANSI, '');

/** Poll a URL until it answers or the deadline passes. */
export async function waitForHttp(url, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  return false;
}

/**
 * Start a service and wait for it to answer /health.
 *
 * `env` is merged over a minimal base rather than the ambient environment, so a
 * variable set for the local dev stack cannot silently influence a test that is
 * specifically about a variable being absent.
 */
export async function startService(name, env = {}, options = {}) {
  const port = options.port ?? (await freePort());
  const bin = BINARIES[name];
  const base = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
  };

  const proc =
    name === 'ai'
      ? spawn(process.execPath, [bin], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin, [], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));

  let exit = null;
  const exited = new Promise((resolve) => {
    proc.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });

  const url = `http://127.0.0.1:${port}`;
  const ready = options.waitForHealth === false ? true : await waitForHttp(`${url}/health`);
  if (!ready && exit === null) {
    proc.kill('SIGKILL');
    throw new Error(`${name} did not become healthy on ${url}\n${logs.join('')}`);
  }

  return {
    name,
    url,
    port,
    proc,
    exited,
    get exit() {
      return exit;
    },
    /**
     * Captured output with ANSI colour codes stripped. The tracing subscriber
     * emits colour even to a pipe, and those escape sequences contain digits
     * and brackets that quietly defeat assertions like /bytes[^0-9]*321/.
     */
    logText: () => stripAnsi(logs.join('')),
    /** Captured output exactly as written, escape codes included. */
    rawLogText: () => logs.join(''),
    /** Send a signal and resolve once the process is gone. */
    async stop(signal = 'SIGTERM', timeout = 10_000) {
      if (exit !== null) return exit;
      proc.kill(signal);
      const timer = sleep(timeout).then(() => 'timeout');
      const result = await Promise.race([exited, timer]);
      if (result === 'timeout') {
        proc.kill('SIGKILL');
        await exited;
        throw new Error(`${name} did not exit within ${timeout}ms of ${signal}`);
      }
      return result;
    },
  };
}
