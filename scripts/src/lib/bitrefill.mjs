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
 *   BITREFILL_FEE_MISMATCH  service fee rate/amount not what the user is shown
 */

import { SkillError } from './output.mjs';
import { normalizeDecimal, MAX_SERVICE_FEE_BPS } from './guards.mjs';
import { parseDeadline } from './expiry.mjs';

export const PROVIDER_BITREFILL = 'bitrefill';
export const PROVIDER_COINBASE = 'coinbase';

/** Bitrefill pays out on Base, in USDC. Nothing else is accepted. */
export const BITREFILL_DESTINATION = Object.freeze({ chainId: '8453', tokenSymbol: 'USDC' });

/** Refuse to CREATE an order for an invoice with less than this much life left. */
export const BITREFILL_MIN_EXPIRY_MS = 5 * 60 * 1000;

/** Refuse to SHOW a deposit or SEND with less than this much life left. */
export const BITREFILL_MIN_PAY_WINDOW_MS = 2 * 60 * 1000;

/**
 * The router rejects an expiry further out than this; mirror it locally.
 * Bitrefill invoices live 60 minutes (measured 2026-11-11); the extra minute
 * absorbs clock skew, matching the router.
 */
export const BITREFILL_MAX_EXPIRY_AHEAD_MS = 61 * 60 * 1000;

/** Router error codes, with what the user should do about each. */
export const BITREFILL_ROUTER_HINTS = {
  BITREFILL_DISABLED: 'Bitrefill payments are switched off on the router right now. Try again later.',
  BITREFILL_NOT_CONFIGURED: 'The router is not configured for Bitrefill payments yet (503). Nothing was created; try again later.',
  RETRY_LATER: 'The router is temporarily unable to create the order (503). Nothing was created; wait a minute and retry the same command.',
  INVALID_INPUT: 'The router rejected the invoice details (400). Check the invoice id, address, amount and expiry against Bitrefill.',
  INVALID_ADDRESS: 'The router rejected the receiving address. Copy it again from the Bitrefill invoice.',
  INVALID_AMOUNT: 'The router rejected the amount. Use the exact USDC amount Bitrefill shows.',
  AMOUNT_OUT_OF_RANGE: 'The amount is outside what the router accepts for Bitrefill invoices (at most 1050 USDC invoice amount).',
  FEE_MISMATCH: 'The router could not price this order with the Bitrefill service fee. Nothing to pay; retry later with a new Bitrefill invoice.',
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
      'The invoice expiry is more than 60 minutes away, which a Bitrefill invoice never is. Check --expires-at.',
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

/** Plain decimal -> BigInt at 18 dp, or null. Used only to compare amounts. */
function dec18(v) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string' || !/^\d+(?:\.\d{1,18})?$/.test(v.trim())) return null;
  const [w, f = ''] = v.trim().split('.');
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0'));
}
function fmt18(n) {
  const w = n / 10n ** 18n;
  const f = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

/**
 * Bitrefill service fee (router 2026-11-11: 1% of the invoice, charged by
 * payment-api as a partner fee and echoed on the order as source.partnerFee /
 * source.partnerFeeBps). The LIVE order is the source of truth; the router's
 * create response, when it carries pricing, must agree with it.
 *
 *   - no partnerFeeBps on the order: an order created before the fee; fee 0.
 *   - feeBps an integer 0..MAX_SERVICE_FEE_BPS (100);
 *   - serviceFee >= 0 and no larger than payment-api's rounding of that rate
 *     allows (invoice x bps, rounded UP to 4 decimals);
 *   - callerPays = invoice + serviceFee exactly;
 *   - for a stablecoin deposit, the deposit must cover callerPays; the rest is
 *     the bridge fee, shown separately, so no part of the deposit is unexplained.
 *
 * @returns {{ok:true, pricing:{original, serviceFee, feeBps, callerPays, bridgeFee}} |
 *           {ok:false, code:'BITREFILL_FEE_MISMATCH', reason, details}}
 */
export function checkBitrefillPricing({ invoiceAmount, source, routerPricing = null }) {
  const bad = (reason, details = {}) => ({ ok: false, code: 'BITREFILL_FEE_MISMATCH', reason, details });
  const original = dec18(invoiceAmount);
  if (original === null) return bad('Invoice amount is not a plain decimal.');
  const hasBps = source && source.partnerFeeBps !== undefined && source.partnerFeeBps !== null;
  let feeBps = 0;
  let fee = 0n;
  if (hasBps) {
    feeBps = source.partnerFeeBps;
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_SERVICE_FEE_BPS) {
      return bad(`Service fee rate ${source.partnerFeeBps} bps is outside 0..${MAX_SERVICE_FEE_BPS} bps; this CLI does not accept it.`);
    }
    const f = dec18(source.partnerFee);
    if (f === null) return bad('The order carries a fee rate but no readable service fee.', { partnerFee: source.partnerFee ?? null });
    // ceil(original * bps / 10000) to 4 dp (10^14 at 18 dp).
    const step = 10n ** 14n;
    const raw = original * BigInt(feeBps);
    const max = ((raw + 10_000n * step - 1n) / (10_000n * step)) * step;
    if (f > max) {
      return bad(`Service fee ${source.partnerFee} is more than ${feeBps} bps of ${invoiceAmount} allows.`, { max: fmt18(max) });
    }
    fee = f;
  }
  const callerPays = original + fee;
  const pricing = {
    original: fmt18(original),
    serviceFee: fmt18(fee),
    feeBps,
    callerPays: fmt18(callerPays),
    bridgeFee: null,
  };
  if (routerPricing && routerPricing.serviceFee !== undefined) {
    const drift = [];
    for (const k of ['original', 'serviceFee', 'callerPays']) {
      const r = dec18(routerPricing[k]);
      if (r === null || fmt18(r) !== pricing[k]) drift.push({ field: k, router: routerPricing[k] ?? null, order: pricing[k] });
    }
    if (routerPricing.feeBps !== feeBps) drift.push({ field: 'feeBps', router: routerPricing.feeBps ?? null, order: feeBps });
    if (drift.length) return bad('The router\'s fee figures differ from the live order.', { drift });
  }
  const token = String(source?.tokenSymbol ?? '').toUpperCase();
  const stable = String(source?.chainId) !== 'lightning' && (token === 'USDC' || token === 'USDT');
  if (stable) {
    const dep = dec18(source?.amount);
    if (dep === null || dep < callerPays) {
      return bad('The deposit does not cover the invoice plus the service fee.', { deposit: source?.amount ?? null, callerPays: pricing.callerPays });
    }
    pricing.bridgeFee = fmt18(dep - callerPays);
  }
  return { ok: true, pricing };
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
