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

export const REPORT_URL = 'https://apiserver.mpprouter.dev/v1/checkout/client-report';
export const REPORT_CLIENT = 'rozo-checkout-cli';
export const REPORT_TIMEOUT_MS = 2_000;
export const MAX_REPORT_BYTES = 2_048;

export const OUTCOMES = new Set(['succeeded', 'refused', 'failed', 'abandoned', 'unconfirmed']);
export const FLOWS = new Set(['coinbase', 'bitrefill', 'x402']);
export const REPORT_KEYS = ['client', 'version', 'outcome', 'code', 'flow', 'rozoPaymentId'];

/**
 * The only codes a report may carry: codes this CLI itself defines (guards,
 * flows, local checks). Anything else, including codes relayed from an
 * upstream service, is sent as OTHER, so upstream text such as an id or an
 * amount folded into a code can never leave the machine.
 */
export const REPORT_CODES = new Set([
  'ALREADY_SENT', 'AMOUNT_PRECISION', 'AWAITING_DEPOSIT', 'BAD_ADDRESS_FAMILY', 'BAD_AMOUNT',
  'BAD_BITREFILL_INVOICE', 'BAD_CHOICE', 'BAD_DECIMALS', 'BAD_DEPOSIT_ADDRESS', 'BAD_ENV_FILE',
  'BAD_INVOICE_AMOUNT', 'BAD_KEY_FORMAT', 'BAD_KEYPAIR_FILE', 'BAD_KEYSTORE', 'BAD_LINK',
  'BAD_PAYER_ADDRESS', 'BAD_PRESET', 'BAD_ROZO_PAYMENT_ID', 'BAD_SATS', 'BAD_USD_REQUIRED',
  'BAD_VALUE', 'BITREFILL_ECHO_MISMATCH', 'BLACKLIST_HIT', 'BLACKLIST_UNAVAILABLE',
  'BOLT11_TOO_SHORT', 'CANCELLED', 'CAP_PER_TX', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_STALE',
  'CONFLICTING_FLAGS', 'CREATE_DRIFT', 'CREATE_FAILED', 'DECIMALS_MISMATCH',
  'DEPOSIT_ACCOUNT_MISMATCH', 'DEPOSIT_ACCOUNT_MISSING', 'DEPOSIT_ACCOUNT_NOT_WALLET',
  'DEPOSIT_BELOW_RENT', 'DEPOSIT_CHANGED', 'DEPOSIT_INCOMPLETE', 'DEPOSIT_MEMO_REQUIRED',
  'DEPOSIT_NOT_LIVE', 'ENV_FILE_MISSING', 'ENV_FILE_PERMISSIONS', 'EXPIRED', 'EXPIRY_UNPARSABLE',
  'GAS_CHECK_UNAVAILABLE', 'HTTP_BAD_JSON', 'HTTP_TIMEOUT', 'HTTP_UNREACHABLE',
  'INSUFFICIENT_BALANCE', 'INSUFFICIENT_GAS', 'INVALID_ADDRESS', 'INVALID_AMOUNT', 'INVALID_EMAIL',
  'INVOICE_EXPIRING', 'INVOICE_EXPIRY_REQUIRED', 'INVOICE_UNSUPPORTED', 'KEYFILE_PERMISSIONS',
  'KEYFILE_UNREADABLE', 'KEYSTORE_BAD_PASSPHRASE', 'KEYSTORE_PASSPHRASE_REQUIRED',
  'LEGACY_COMMERCE_URL', 'LINK_NO_LONGER_PAYABLE', 'LINK_PAYABILITY_UNKNOWN', 'LOCK_TIMEOUT',
  'MISSING_EXPECTED_AMOUNT', 'MISSING_KEY', 'MISSING_PRESET', 'MISSING_TARGET',
  'NATIVE_AMOUNT_TOO_HIGH', 'NATIVE_AMOUNT_TOO_LOW', 'NATIVE_AMOUNT_UNKNOWN',
  'NATIVE_NOT_AVAILABLE', 'NATIVE_NOT_OFFERED', 'NATIVE_TOKEN_ADDRESS_UNEXPECTED', 'NO_KEY_SOURCE',
  'NO_ORDER_STATE', 'NO_RESULT', 'NO_RPC', 'NO_SEND_CLAIM', 'NO_TOKEN_ACCOUNT', 'NO_TOKEN_ADDRESS',
  'NOT_CONFIRMED', 'NOT_NATIVE', 'ORDER_ALREADY_FUNDED', 'ORDER_ALREADY_PAID', 'ORDER_EXPIRED',
  'ORDER_NEEDS_ATTENTION', 'ORDER_NOT_RESUMABLE', 'ORDER_STATE_UNKNOWN', 'PREPARED_TX_MISMATCH',
  'PRICING_VIOLATION', 'RATE_LIMITED', 'REUSED_SOURCE_MISMATCH', 'RPC_CHAIN_MISMATCH',
  'RPC_READ_FAILED', 'RPC_UNREACHABLE', 'RUNTIME_ERROR', 'SEND_NOT_OPTED_IN',
  'SEND_UNSUPPORTED_CHAIN', 'STATE_CORRUPT', 'STATE_UNREADABLE', 'TOKEN_READ_FAILED',
  'TRACKED_DOTENV', 'TRACKED_DOTENV_UNVERIFIABLE', 'TRACKED_KEYFILE', 'TX_FAILED', 'TX_REVERTED',
  'TX_UNCONFIRMED', 'UNKNOWN_DECIMALS', 'UNSUPPORTED_SOURCE', 'USER_CANCELLED',
  'WRONG_SENDER_SCRIPT', 'X402_BAD_CHALLENGE', 'X402_BAD_KEY', 'X402_BAD_SIGNATURE',
  'X402_BAD_TOPUP', 'X402_NO_KEY', 'X402_NOT_402', 'X402_OVER_BUDGET', 'X402_PAYER_DISABLED',
  'X402_PAYMENT_REJECTED', 'X402_REPLAY_FAILED', 'X402_TOPUP_MISMATCH',
  'X402_TOPUP_SOURCE_UNSUPPORTED', 'X402_UNSUPPORTED', 'ZEC_ADDRESS_INVALID',
  'ZEC_AMOUNT_TOO_HIGH', 'ZEC_AMOUNT_TOO_LOW', 'ZEC_AMOUNT_UNKNOWN', 'ZEC_NOT_OFFERED',
  'ZEC_PAYMENT_URI_INVALID', 'ZEC_PAYMENT_URI_MISMATCH', 'ZEC_PAYMENT_URI_MISSING',
  'ZEC_QUOTE_EXPIRED', 'ZEC_RECEIVE_MODE_MISMATCH', 'ZEC_SHIELDED_NOT_AVAILABLE',
  'ZEC_SHIELDED_REQUIRED',
]);
export const OTHER_CODE = 'OTHER';
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
    c = REPORT_CODES.has(String(code)) ? String(code) : OTHER_CODE;
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
  // Pinned: there is deliberately no runtime override of the destination.
  const url = REPORT_URL;
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
