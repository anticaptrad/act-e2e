// Small HTTP helpers shared by the integration suites.
import { timeoutMs } from '../config.mjs';

/** GET a URL, returning status, headers, and raw body text. */
export async function get(url, options = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** GET and parse the body as JSON. */
export async function getJson(url, options = {}) {
  const { status, headers, body } = await get(url, options);
  return { status, headers, json: safeParse(body), body };
}

/** POST a JSON payload, returning status and parsed body when possible. */
export async function postJson(url, payload, options = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, json: safeParse(body), body };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A JSON-RPC 2.0 request envelope. */
export function rpc(method, params, id = 1) {
  const req = { jsonrpc: '2.0', method };
  if (params !== undefined) req.params = params;
  if (id !== null) req.id = id;
  return req;
}
