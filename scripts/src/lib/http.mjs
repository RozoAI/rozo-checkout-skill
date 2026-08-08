/**
 * Minimal JSON HTTP client. All rozo-checkout endpoints are public/keyless
 * (PLAN §2) — this client deliberately has no place to put a credential.
 */

import { SkillError, redact } from './output.mjs';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const USER_AGENT = 'rozo-checkout-skill/1.0';

async function request(method, url, { body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new SkillError(
      err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE',
      `${method} request failed: ${redact(err?.message || String(err))}`,
      { url: redactUrl(url) },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const code =
      json?.code ||
      json?.error?.code ||
      (typeof json?.error === 'string' ? null : null) ||
      `HTTP_${res.status}`;
    const message =
      json?.message ||
      (typeof json?.error === 'string' ? json.error : json?.error?.message) ||
      `HTTP ${res.status}`;
    throw new SkillError(code, redact(String(message)), {
      httpStatus: res.status,
      url: redactUrl(url),
      body: json ?? redact(text).slice(0, 800),
    });
  }
  if (json === null) {
    throw new SkillError('HTTP_BAD_JSON', 'Endpoint returned a non-JSON body.', {
      url: redactUrl(url),
      snippet: redact(text).slice(0, 400),
    });
  }
  return json;
}

/** Strip query strings that could carry identifiers we do not want echoed. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url);
  }
}

export function getJson(url, opts) {
  return request('GET', url, opts);
}

export function postJson(url, body, opts) {
  return request('POST', url, { ...opts, body });
}
