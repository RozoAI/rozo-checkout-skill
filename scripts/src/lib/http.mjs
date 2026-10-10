/**
 * Minimal JSON HTTP client. All rozo-checkout endpoints are public/keyless
 * (PLAN §2) — this client deliberately has no place to put a credential.
 *
 * Rate limits: a 429 (or a 503 that carries Retry-After) is retried up to
 * MAX_RETRIES times. The wait is the server's Retry-After header (seconds or
 * HTTP-date), else the body's `retryAfterSeconds`, else a short exponential
 * backoff. The waits of one call never add up to more than MAX_TOTAL_WAIT_MS:
 * when the server asks for longer than the remaining budget we do not sleep a
 * truncated time (that would only earn another 429), we fail at once with the
 * server's value and any X-RateLimit-* headers in the error details. A caller
 * whose body goes stale (a quote receipt) passes a smaller `maxTotalWaitMs`.
 */

import { SkillError, redact } from './output.mjs';
import { PKG_VERSION } from './version.mjs';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const USER_AGENT = `rozo-checkout-skill/${PKG_VERSION}`;

export const MAX_RETRIES = 3;
export const MAX_TOTAL_WAIT_MS = 120_000;
/** Backoff for a 429 that gives no hint: 2s, 4s, 8s. */
const FALLBACK_BACKOFF_MS = [2_000, 4_000, 8_000];

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry-After as milliseconds. Accepts delta-seconds ("30") or an HTTP-date.
 * Returns null when absent or unparsable; a date in the past is 0.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/** Body hint (`retryAfterSeconds`, top level or under `error`) as ms, or null. */
function bodyRetryAfterMs(json) {
  const raw = json?.retryAfterSeconds ?? json?.error?.retryAfterSeconds;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

/** X-RateLimit-* headers worth showing to the caller, or null if none. */
function rateLimitInfo(res) {
  const pick = (name) => res.headers?.get?.(name) ?? null;
  const info = {
    limit: pick('x-ratelimit-limit'),
    remaining: pick('x-ratelimit-remaining'),
    tier: pick('x-ratelimit-tier'),
    scope: pick('x-ratelimit-scope'),
  };
  const present = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== null));
  return Object.keys(present).length ? present : null;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchOnce(method, url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // Read the body inside the timeout so a stalled stream also aborts.
    const text = await res.text();
    return { res, text };
  } catch (err) {
    throw new SkillError(
      err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE',
      `${method} request failed: ${redact(err?.message || String(err))}`,
      { url: redactUrl(url) },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function request(
  method,
  url,
  {
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = defaultSleep,
    now = Date.now,
    maxTotalWaitMs = MAX_TOTAL_WAIT_MS,
  } = {},
) {
  let waitedMs = 0;
  let retries = 0;
  for (;;) {
    const { res, text } = await fetchOnce(method, url, body, timeoutMs);
    const json = parseBody(text);

    if (res.ok) {
      if (json === null) {
        throw new SkillError('HTTP_BAD_JSON', 'Endpoint returned a non-JSON body.', {
          url: redactUrl(url),
          snippet: redact(text).slice(0, 400),
        });
      }
      return json;
    }

    const headerWaitMs = parseRetryAfter(res.headers?.get?.('retry-after'), now());
    const hintMs = headerWaitMs ?? bodyRetryAfterMs(json);
    const retryable = res.status === 429 || (res.status === 503 && hintMs !== null);
    if (retryable && retries < MAX_RETRIES) {
      const waitMs = hintMs ?? FALLBACK_BACKOFF_MS[retries];
      if (waitedMs + waitMs <= Math.min(maxTotalWaitMs, MAX_TOTAL_WAIT_MS)) {
        retries += 1;
        waitedMs += waitMs;
        await sleep(waitMs);
        continue;
      }
    }

    const code =
      json?.code ||
      json?.error?.code ||
      (typeof json?.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(json.error) ? json.error : null) ||
      `HTTP_${res.status}`;
    const message =
      json?.message ||
      (typeof json?.error === 'string' ? json.error : json?.error?.message) ||
      `HTTP ${res.status}`;
    const rateLimit = rateLimitInfo(res);
    throw new SkillError(code, redact(String(message)), {
      httpStatus: res.status,
      url: redactUrl(url),
      body: json ?? redact(text).slice(0, 800),
      ...(retryable
        ? {
            retries,
            retryAfterSeconds: hintMs === null ? null : Math.ceil(hintMs / 1000),
          }
        : {}),
      ...(rateLimit ? { rateLimit } : {}),
    });
  }
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
