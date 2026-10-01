/**
 * Bitrefill invoice support — pure validation and verification.
 *
 * A Bitrefill invoice paid in "USDC on Base" gives the payer three facts: an
 * invoice id, a Base address and an exact USDC amount (plus an expiry). The
 * skill asks mpprouter to create a Rozo exactOut intent that delivers exactly
 * that amount to exactly that address, and then funds it from whatever coin
 * the user holds. Nothing here does I/O, so every rail is unit-tested.
 *
 * Error codes (all hard aborts):
 *   BAD_BITREFILL_INVOICE   invoice id missing or malformed
 *   INVALID_ADDRESS         destination is not a 0x… 40-hex EVM address
 *   INVALID_AMOUNT          amount not a positive USDC decimal with ≤ 6 dp
 *   INVOICE_EXPIRING        less than BITREFILL_MIN_EXPIRY_MS left (or unparsable)
 *   BITREFILL_ECHO_MISMATCH router / intent disagrees with what was asked for
 */

import { SkillError } from './output.mjs';
import { normalizeDecimal } from './guards.mjs';
import { parseDeadline } from './expiry.mjs';

export const PROVIDER_BITREFILL = 'bitrefill';
export const PROVIDER_COINBASE = 'coinbase';

/** Bitrefill pays out on Base, in USDC. Nothing else is accepted. */
export const BITREFILL_DESTINATION = Object.freeze({ chainId: '8453', tokenSymbol: 'USDC' });

/** Refuse to CREATE an order for an invoice with less than this much life left. */
export const BITREFILL_MIN_EXPIRY_MS = 5 * 60 * 1000;

/** Refuse to SHOW a deposit or SEND with less than this much life left. */
export const BITREFILL_MIN_PAY_WINDOW_MS = 2 * 60 * 1000;

/** The router rejects an expiry further out than this; mirror it locally. */
export const BITREFILL_MAX_EXPIRY_AHEAD_MS = 30 * 60 * 1000;

/** Router error codes, with what the user should do about each. */
export const BITREFILL_ROUTER_HINTS = {
  BITREFILL_DISABLED: 'Bitrefill payments are switched off on the router right now. Try again later.',
  BITREFILL_NOT_CONFIGURED: 'The router is not configured for Bitrefill payments yet (503). Nothing was created; try again later.',
  RETRY_LATER: 'The router is temporarily unable to create the order (503). Nothing was created; wait a minute and retry the same command.',
  INVALID_INPUT: 'The router rejected the invoice details (400). Check the invoice id, address, amount and expiry against Bitrefill.',
  INVALID_ADDRESS: 'The router rejected the receiving address. Copy it again from the Bitrefill invoice.',
  INVALID_AMOUNT: 'The router rejected the amount. Use the exact USDC amount Bitrefill shows.',
  AMOUNT_OUT_OF_RANGE: 'The amount is outside what the router accepts for Bitrefill invoices.',
  INVOICE_EXPIRING: 'The invoice expires too soon (or too far out) for the router. Create a fresh Bitrefill invoice.',
  BLOCKED_ADDRESS: 'The router refused this receiving address. Do not pay it; report it.',
  UNSUPPORTED_SOURCE: 'The router does not accept this coin for Bitrefill invoices. Choose another coin.',
};

/** Re-throw a router error with a clear, actionable message; code unchanged. */
export function explainRouterError(err) {
  const hint = BITREFILL_ROUTER_HINTS[err?.code];
  if (!hint) return err;
  return new SkillError(err.code, `${hint}${err.message ? ` (router: ${err.message})` : ''}`, err.details);
}

/**
 * Expiry for a Bitrefill order comes from the invoice ONLY — never from the
 * Rozo intent's own expiresAt. Shape mirrors checkExpiry for the callers.
 */
export function checkBitrefillExpiry(expiresAt, now = Date.now(), minMs = BITREFILL_MIN_PAY_WINDOW_MS) {
  const ms = parseDeadline(expiresAt);
  const base = { marginMs: minMs, deadlines: { invoiceMs: ms } };
  if (ms === null) {
    return { ...base, ok: false, code: 'EXPIRY_UNPARSABLE', reason: 'The Bitrefill invoice expiry is missing or unreadable.', effectiveDeadlineMs: null, msRemaining: null, msOfSlack: null };
  }
  const msRemaining = ms - now;
  const out = { ...base, effectiveDeadlineMs: ms, msRemaining, msOfSlack: msRemaining - minMs };
  if (msRemaining <= 0) return { ...out, ok: false, code: 'EXPIRED', reason: 'The Bitrefill invoice has expired.' };
  if (msRemaining < minMs) {
    return {
      ...out,
      ok: false,
      code: 'INVOICE_EXPIRING',
      reason: `Only ${Math.floor(msRemaining / 1000)}s left on the Bitrefill invoice; at least ${Math.round(minMs / 60000)} min is required. Create a fresh invoice.`,
    };
  }
  return { ...out, ok: true, code: null, reason: null };
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const INVOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

/**
 * Validate the user-supplied invoice facts before anything touches the network.
 * Returns a normalized copy; throws SkillError on the first problem.
 */
export function validateBitrefillInput(
  { invoiceId, address, amount, expiresAt },
  now = Date.now(),
  minMs = BITREFILL_MIN_EXPIRY_MS,
) {
  const id = String(invoiceId ?? '').trim();
  if (!INVOICE_ID_RE.test(id)) {
    throw new SkillError(
      'BAD_BITREFILL_INVOICE',
      'A Bitrefill invoice id is required (letters, digits, "-" or "_").',
    );
  }
  const addr = String(address ?? '').trim();
  if (!EVM_ADDRESS_RE.test(addr)) {
    throw new SkillError(
      'INVALID_ADDRESS',
      'The Bitrefill receiving address must be a Base (EVM) address: 0x followed by 40 hex characters.',
    );
  }
  const amt = String(amount ?? '').trim();
  if (!AMOUNT_RE.test(amt) || normalizeDecimal(amt) === '0') {
    throw new SkillError(
      'INVALID_AMOUNT',
      'The amount must be a positive USDC amount with at most 6 decimals, exactly as Bitrefill shows it.',
    );
  }
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') {
    throw new SkillError('INVOICE_EXPIRY_REQUIRED', 'The Bitrefill invoice expiry is required (--expires-at <ISO>), exactly as Bitrefill shows it.');
  }
  const ms = parseDeadline(expiresAt);
  if (ms === null) {
    throw new SkillError('INVOICE_EXPIRING', 'The invoice expiry could not be read.');
  }
  if (ms - now < minMs) {
    throw new SkillError(
      'INVOICE_EXPIRING',
      `The Bitrefill invoice expires in less than ${Math.round(minMs / 60000)} minutes. Create a fresh invoice on Bitrefill.`,
      { expiresAt: new Date(ms).toISOString() },
    );
  }
  if (ms - now > BITREFILL_MAX_EXPIRY_AHEAD_MS) {
    throw new SkillError(
      'INVOICE_EXPIRING',
      'The invoice expiry is more than 30 minutes away, which a Bitrefill invoice never is. Check --expires-at.',
      { expiresAt: new Date(ms).toISOString() },
    );
  }
  const expiresIso = new Date(ms).toISOString();
  return { invoiceId: id, address: addr, amount: normalizeDecimal(amt), expiresAt: expiresIso };
}

const sameAddress = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The router's create response must echo exactly the invoice that was asked
 * for. Any difference means the order would pay someone or something else.
 */
export function verifyBitrefillCreate({ requested, created }) {
  const drift = [];
  const dest = created?.destination || {};
  if (created?.provider !== PROVIDER_BITREFILL) {
    drift.push({ field: 'provider', requested: PROVIDER_BITREFILL, created: created?.provider ?? null });
  }
  if (String(created?.invoiceId ?? '') !== requested.invoiceId) {
    drift.push({ field: 'invoiceId', requested: requested.invoiceId, created: created?.invoiceId ?? null });
  }
  if (!sameAddress(dest.address, requested.address)) {
    drift.push({ field: 'destination.address', requested: requested.address, created: dest.address ?? null });
  }
  if (normalizeDecimal(dest.amount) !== normalizeDecimal(requested.amount)) {
    drift.push({ field: 'destination.amount', requested: requested.amount, created: dest.amount ?? null });
  }
  if (String(dest.chainId ?? '') !== BITREFILL_DESTINATION.chainId) {
    drift.push({ field: 'destination.chainId', requested: '8453', created: dest.chainId ?? null });
  }
  if (String(dest.tokenSymbol ?? '').toUpperCase() !== BITREFILL_DESTINATION.tokenSymbol) {
    drift.push({ field: 'destination.tokenSymbol', requested: 'USDC', created: dest.tokenSymbol ?? null });
  }
  return drift.length
    ? {
        ok: false,
        code: 'BITREFILL_ECHO_MISMATCH',
        reason: 'The router created an order that does not match the Bitrefill invoice. Refusing to continue.',
        drift,
      }
    : { ok: true, code: null, reason: null, drift };
}

/**
 * The authoritative intent (GET payments/<id>) must deliver to the same place.
 * Chain, token, amount and receiver address are all REQUIRED; a missing field
 * is a mismatch.
 */
export function verifyBitrefillDestination({ requested, payment }) {
  const dest = payment?.destination || {};
  const drift = [];
  if (String(dest.chainId ?? '') !== BITREFILL_DESTINATION.chainId) {
    drift.push({ field: 'destination.chainId', requested: '8453', live: dest.chainId ?? null });
  }
  if (String(dest.tokenSymbol ?? '').toUpperCase() !== BITREFILL_DESTINATION.tokenSymbol) {
    drift.push({ field: 'destination.tokenSymbol', requested: 'USDC', live: dest.tokenSymbol ?? null });
  }
  if (normalizeDecimal(dest.amount) !== normalizeDecimal(requested.amount)) {
    drift.push({ field: 'destination.amount', requested: requested.amount, live: dest.amount ?? null });
  }
  const liveAddress = dest.receiverAddress ?? dest.address ?? null;
  // Fail closed: an intent that does not say where it pays cannot be proved
  // to pay Bitrefill.
  if (!sameAddress(liveAddress, requested.address)) {
    drift.push({ field: 'destination.address', requested: requested.address, live: liveAddress });
  }
  return drift.length
    ? {
        ok: false,
        code: 'BITREFILL_ECHO_MISMATCH',
        reason: 'The live order does not deliver to the Bitrefill invoice. Refusing to continue.',
        drift,
        addressVerified: false,
      }
    : { ok: true, code: null, reason: null, drift, addressVerified: true };
}

/**
 * DUPLICATE_INVOICE (409) carries the existing rozoPaymentId: resume that
 * order instead of creating another. Returns the id, or null.
 */
export function duplicateInvoicePaymentId(err) {
  if (err?.code !== 'DUPLICATE_INVOICE') return null;
  const body = err?.details?.body;
  const id = body?.rozoPaymentId ?? body?.existing?.rozoPaymentId ?? null;
  return typeof id === 'string' && id ? id : null;
}

/** Provider of an intent as the backend describes it (orderId prefix / metadata). */
export function providerFromPayment(payment) {
  if (!payment) return null;
  if (String(payment.orderId ?? payment.order_id ?? '').startsWith('bitrefill_')) return PROVIDER_BITREFILL;
  const meta = payment.metadata?.provider;
  if (meta) return String(meta).toLowerCase();
  return null;
}

/** Earliest of the given deadlines as ISO, ignoring blanks; null if none parse. */
export function earliestExpiry(...values) {
  const ms = values.map((v) => parseDeadline(v)).filter((v) => v !== null);
  return ms.length ? new Date(Math.min(...ms)).toISOString() : null;
}

/** The invoice deadline the intent itself carries, if the router stored one. */
export function intentBitrefillExpiry(payment) {
  return payment?.metadata?.bitrefillExpiresAt ?? null;
}
