/**
 * Client result report: one anonymous line per finished pay attempt, so Rozo
 * can see how CLI payments end (succeeded, refused by a guard, failed on
 * chain, abandoned, unconfirmed) without the user having to tell us.
 *
 *   POST {REPORT_URL}  {client, version, outcome, code, flow, rozoPaymentId?}
 *
 * Off by default: it is sent only when ROZO_CHECKOUT_REPORT=1, and never when
 * ROZO_CHECKOUT_NO_REPORT=1. The payload is built from an allowlist: no
 * address, amount, tx hash, link, email or free text can be put in it. Sending
 * never throws, never waits more than REPORT_TIMEOUT_MS, and never changes the
 * command's output or exit code.
 */

import { PKG_VERSION } from './version.mjs';
import { USER_AGENT } from './http.mjs';

export const REPORT_URL_DEFAULT = 'https://apiserver.mpprouter.dev/v1/checkout/client-report';
export const REPORT_CLIENT = 'rozo-checkout-cli';
export const REPORT_TIMEOUT_MS = 2_000;
export const MAX_REPORT_BYTES = 2_048;

export const OUTCOMES = new Set(['succeeded', 'refused', 'failed', 'abandoned', 'unconfirmed']);
export const FLOWS = new Set(['coinbase', 'bitrefill', 'x402']);
export const REPORT_KEYS = ['client', 'version', 'outcome', 'code', 'flow', 'rozoPaymentId'];

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reportingEnabled(env = process.env) {
  return env.ROZO_CHECKOUT_REPORT === '1' && env.ROZO_CHECKOUT_NO_REPORT !== '1';
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The report body, or null when the inputs do not make a valid one. */
export function buildReport({ outcome, code = null, flow = null, rozoPaymentId = null, version = PKG_VERSION }) {
  if (!OUTCOMES.has(outcome)) return null;
  let c = null;
  if (outcome !== 'succeeded' && code !== null && code !== undefined) {
    c = CODE_RE.test(String(code)) ? String(code) : 'UNKNOWN';
  }
  const report = {
    client: REPORT_CLIENT,
    version: String(version),
    outcome,
    code: c,
    flow: FLOWS.has(flow) ? flow : null,
  };
  if (isUuid(rozoPaymentId)) report.rozoPaymentId = rozoPaymentId.toLowerCase();
  return report;
}

/** Codes that mean something broke, as opposed to a guard saying no. */
export function isFailureCode(code) {
  return /^(TX_|HTTP_)/.test(code) || ['RUNTIME_ERROR', 'NO_RESULT', 'BROADCAST_FAILED', 'SEND_FAILED'].includes(code);
}

/**
 * Turn what a pay attempt left behind into {outcome, code}, or null when there
 * is nothing to report (usage error, dry run, x402 call that needed no payment).
 *
 * trace: { code, skip, abandoned, settled, sendConfirmed, sendUnconfirmed, paid, flow }
 */
export function classifyAttempt(trace, exitCode) {
  if (!trace || trace.skip || exitCode === 2) return null;
  if (exitCode === 3) return { outcome: 'unconfirmed', code: trace.code ?? null };
  if (exitCode === 0) {
    if (trace.abandoned) return { outcome: 'abandoned', code: 'USER_CANCELLED' };
    if (trace.settled || trace.sendConfirmed || trace.paid) return { outcome: 'succeeded', code: null };
    if (trace.flow === 'x402') return null;
    if (trace.sendUnconfirmed) return { outcome: 'unconfirmed', code: 'TX_UNCONFIRMED' };
    // Deposit details handed to the user; the CLI does not know if they paid.
    return { outcome: 'unconfirmed', code: 'AWAITING_DEPOSIT' };
  }
  const code = trace.code || 'RUNTIME_ERROR';
  return { outcome: isFailureCode(code) ? 'failed' : 'refused', code };
}

/** POST the report. Resolves (never rejects) within timeoutMs. */
export async function sendReport(report, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = REPORT_TIMEOUT_MS } = {}) {
  if (!report || !reportingEnabled(env) || typeof fetchImpl !== 'function') return false;
  const body = JSON.stringify(Object.fromEntries(REPORT_KEYS.filter((k) => k in report).map((k) => [k, report[k]])));
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES) return false;
  const url = env.ROZO_CHECKOUT_REPORT_URL || REPORT_URL_DEFAULT;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });
  const attempt = (async () => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      return res.status === 204 || res.ok;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
