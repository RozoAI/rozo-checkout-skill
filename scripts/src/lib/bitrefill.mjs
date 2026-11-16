/**
 * Bitrefill invoice support — pure validation and verification.
 *
 * A Bitrefill invoice paid in "USDC on Base" gives the payer three facts: an
 * invoice id, a Base address and an exact USDC amount (plus an expiry). The
 * skill asks mpprouter to create a Rozo exactOut order for it and then funds
 * it from whatever coin the user holds. Two router models exist (see
 * bitrefill-model.mjs): the current direct model (the payout pays the
 * invoice address, no fee) and the funder model of mpprouter #315 (the payout
 * goes to the Rozo funder for invoice + 1%, the funder pays the invoice).
 * Nothing here does I/O, so every rail is unit-tested.
 *
 * Error codes (all hard aborts):
 *   BAD_BITREFILL_INVOICE   invoice id missing or malformed
 *   INVALID_ADDRESS         destination is not a 0x… 40-hex EVM address
 *   INVALID_AMOUNT          amount not a positive USDC decimal with ≤ 6 dp
 *   INVOICE_EXPIRING        less than BITREFILL_MIN_EXPIRY_MS left (or unparsable)
 *   BITREFILL_ECHO_MISMATCH router / intent disagrees with what was asked for
 *   BITREFILL_FEE_MISMATCH  fee figures partial, inconsistent, or not what the live order charges
 */

import { SkillError } from './output.mjs';
import { normalizeDecimal, checkPricing, serviceFeeAtomicFor } from './guards.mjs';
import { parseDeadline, marginFor } from './expiry.mjs';
import { toAtomic } from './amounts.mjs';
import { BITREFILL_FUNDER, BITREFILL_FEE_BPS, isBitrefillFunderOrder } from './bitrefill-model.mjs';

export { BITREFILL_FUNDER, BITREFILL_FEE_BPS, isBitrefillFunderOrder };

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

/**
 * What happens to money that reaches Rozo after the Bitrefill invoice expired
 * (funder model). No refund timing or amount is promised.
 */
export const BITREFILL_LATE_PAYMENT_POLICY =
  'Funds that arrive after the Bitrefill invoice expires are not forwarded to Bitrefill; ' +
  'they are refunded manually on request: contact hi@rozo.ai with the invoice id and rozoPaymentId.';

/**
 * Shown when money reached Rozo on a funder order, the invoice has expired (or
 * is inside its last BITREFILL_MIN_PAY_WINDOW_MS, where the funder's signer
 * refuses to pay), and Rozo has not stamped the order delivered. The invoice
 * may in fact be paid (the delivered stamp can lag or fail), so the first step
 * is Bitrefill's own page; support comes second, refunds only after that.
 */
export const BITREFILL_LATE_PAYMENT_DETAIL =
  'Your payment reached Rozo, but Rozo has not confirmed paying the Bitrefill invoice, and the invoice has expired ' +
  'or has under 2 minutes left (Rozo does not pay an invoice inside its last 2 minutes). Do not pay again. ' +
  "First check the invoice on Bitrefill's page: it may in fact be paid, and Bitrefill's page is the source of truth. " +
  'If it is paid, nothing else is needed. If it is not, contact hi@rozo.ai with the invoice id and rozoPaymentId. ' +
  'Funds that arrive after the invoice expires are not forwarded to Bitrefill; they are refunded manually on request.';

/** Router error codes, with what the user should do about each. */
export const BITREFILL_ROUTER_HINTS = {
  BITREFILL_DISABLED: 'Bitrefill payments are switched off on the router right now. Try again later.',
  BITREFILL_INVOICE_NOT_ALLOWED:
    'Bitrefill payments through Rozo are temporarily unavailable for this invoice (403). Nothing was created and nothing was charged; no deposit address is shown. Do not send any funds for this invoice through Rozo. Retrying right away will not help: try again later, or pay the invoice on Bitrefill another way.',
  BITREFILL_NOT_CONFIGURED: 'The router is not configured for Bitrefill payments yet (503). Nothing was created; try again later.',
  RETRY_LATER: 'The router could not reserve or finish the order for this invoice right now (503). Do not pay anything yet; wait a minute and retry the same command, which resumes the same order.',
  DUPLICATE_INVOICE: 'This Bitrefill invoice already has a payment that was started under the other Rozo checkout model (409), so a second one is not created. Do not pay again: finish the payment you already started, or check the invoice on Bitrefill. If you are unsure, contact hi@rozo.ai with the invoice id.',
  INTENTS_API_FAILED: 'The router could not reach the Rozo order service (502). Nothing to pay yet; retry the same command shortly.',
  INVALID_INPUT: 'The router rejected the invoice details (400). Check the invoice id, address, amount and expiry against Bitrefill.',
  INVALID_ADDRESS: 'The router rejected the receiving address. Copy it again from the Bitrefill invoice.',
  INVALID_AMOUNT: 'The router rejected the amount. Use the exact USDC amount Bitrefill shows.',
  AMOUNT_OUT_OF_RANGE: 'The amount is outside what the router accepts for Bitrefill invoices (at most 1050 USDC invoice amount; native coins have their own per-invoice USD limit).',
  INVOICE_EXPIRING: 'The invoice expires too soon (or too far out) for the router. Create a fresh Bitrefill invoice.',
  BLOCKED_ADDRESS: 'The router refused this receiving address. Do not pay it; report it.',
  UNSUPPORTED_SOURCE: 'The router does not accept this coin for Bitrefill invoices right now. Choose another coin (USDC or USDT always work).',
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
export function checkBitrefillExpiry(
  expiresAt,
  now = Date.now(),
  minMs = BITREFILL_MIN_PAY_WINDOW_MS,
  { quoteExpiresAt = undefined, chainId = null } = {},
) {
  const ms = parseDeadline(expiresAt);
  // Native coins: the price lock is a second deadline (undefined = not native,
  // null = native without a lock, which is refused like an unreadable expiry).
  const native = quoteExpiresAt !== undefined;
  const quoteMs = native ? parseDeadline(quoteExpiresAt) : null;
  const base = { marginMs: minMs, deadlines: { invoiceMs: ms, quoteMs } };
  const none = { effectiveDeadlineMs: null, msRemaining: null, msOfSlack: null };
  if (ms === null) {
    return { ...base, ...none, ok: false, code: 'EXPIRY_UNPARSABLE', reason: 'The Bitrefill invoice expiry is missing or unreadable.' };
  }
  if (native && quoteMs === null) {
    return {
      ...base,
      ...none,
      ok: false,
      code: 'EXPIRY_UNPARSABLE',
      reason: 'This native coin order carries no price lock (quoteExpiresAt), so the coin amount cannot be trusted. Refusing to treat it as payable.',
    };
  }
  // Invoice window (2 min). For a native coin also the price lock, with the
  // OpenRouter line's per-chain safety margin (checkExpiry / marginFor).
  const msRemaining = ms - now;
  const quoteMarginMs = native ? Math.max(minMs, marginFor(chainId)) : null;
  const lockFirst = native && quoteMs < ms;
  const out = {
    ...base,
    marginMs: lockFirst ? quoteMarginMs : minMs,
    effectiveDeadlineMs: lockFirst ? quoteMs : ms,
    msRemaining: lockFirst ? quoteMs - now : msRemaining,
    msOfSlack: native ? Math.min(quoteMs - now - quoteMarginMs, msRemaining - minMs) : msRemaining - minMs,
  };
  if (native) {
    const qRemaining = quoteMs - now;
    if (qRemaining <= 0) {
      return { ...out, ok: false, code: 'QUOTE_EXPIRED', reason: 'The coin price lock for this order has passed. Do not send it; let the order expire unfunded and start again.' };
    }
    if (qRemaining < quoteMarginMs) {
      return {
        ...out,
        ok: false,
        code: 'QUOTE_EXPIRY_MARGIN',
        reason: `Only ${Math.floor(qRemaining / 1000)}s left on the coin price lock; this chain needs a ${Math.round(quoteMarginMs / 60000)} min safety margin.`,
      };
    }
  }
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
  // The id is sent as typed: the funder-model router lowercases it itself, and
  // the current router keys existing orders by the id as sent, so changing
  // case here could hide an existing order from it. Echoes compare
  // case-insensitively instead.
  return { invoiceId: id, address: addr, amount: normalizeDecimal(amt), expiresAt: expiresIso };
}

const sameAddress = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Invoice ids compare case-insensitively: the funder-model router lowercases UUIDs. */
const sameInvoiceId = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase() && String(a ?? '').trim() !== '';

/**
 * The router's create response must echo exactly the invoice that was asked
 * for. Any difference means the order would pay someone or something else.
 * (Both router models echo the Bitrefill address and invoice amount here; in
 * the funder model the live order pays the funder, checked separately.)
 */
export function verifyBitrefillCreate({ requested, created }) {
  const drift = [];
  const dest = created?.destination || {};
  if (created?.provider !== PROVIDER_BITREFILL) {
    drift.push({ field: 'provider', requested: PROVIDER_BITREFILL, created: created?.provider ?? null });
  }
  if (!sameInvoiceId(created?.invoiceId, requested.invoiceId)) {
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

/** USDC decimal -> atomic (6 dp) BigInt, or null when it is not a plain amount. */
function usdcAtomic(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) return null;
  try {
    return toAtomic(s, 6);
  } catch {
    return null;
  }
}
function atomicToUsdc(a) {
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
function atomicField(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return /^\d+$/.test(s) ? BigInt(s) : null;
}

/**
 * The authoritative intent (GET payments/<id>) must pay what the invoice
 * needs. Chain, token, amount and receiver are all REQUIRED; a missing field
 * is a mismatch.
 *
 *   direct model: pays the Bitrefill address exactly the invoice amount.
 *   funder model: pays the Rozo funder exactly invoice + 1% (rounded up to the
 *     cent), and metadata.bitrefill freezes the Bitrefill address, the invoice
 *     amount and the fee the funder will pay from. Those frozen facts must be
 *     this invoice.
 *
 * @returns {{ok:boolean, code, reason, drift, addressVerified:boolean,
 *            model:'direct'|'funder', livePricing:{original, serviceFee, feeBps, callerPays, callerPaysAtomicUsdc}|null}}
 */
export function verifyBitrefillDestination({ requested, payment }) {
  const dest = payment?.destination || {};
  const drift = [];
  const model = isBitrefillFunderOrder(payment) ? 'funder' : 'direct';
  if (String(dest.chainId ?? '') !== BITREFILL_DESTINATION.chainId) {
    drift.push({ field: 'destination.chainId', requested: '8453', live: dest.chainId ?? null });
  }
  if (String(dest.tokenSymbol ?? '').toUpperCase() !== BITREFILL_DESTINATION.tokenSymbol) {
    drift.push({ field: 'destination.tokenSymbol', requested: 'USDC', live: dest.tokenSymbol ?? null });
  }
  const liveAddress = dest.receiverAddress ?? dest.address ?? null;
  const invoiceAtomic = usdcAtomic(requested.amount);
  let livePricing = null;

  if (model === 'direct') {
    if (normalizeDecimal(dest.amount) !== normalizeDecimal(requested.amount)) {
      drift.push({ field: 'destination.amount', requested: requested.amount, live: dest.amount ?? null });
    }
    // Fail closed: an intent that does not say where it pays cannot be proved
    // to pay Bitrefill.
    if (!sameAddress(liveAddress, requested.address)) {
      drift.push({ field: 'destination.address', requested: requested.address, live: liveAddress });
    }
    if (invoiceAtomic !== null) {
      const amt = atomicToUsdc(invoiceAtomic);
      livePricing = { original: amt, serviceFee: '0', feeBps: 0, callerPays: amt, callerPaysAtomicUsdc: invoiceAtomic.toString() };
    }
  } else {
    if (!sameAddress(liveAddress, BITREFILL_FUNDER)) {
      drift.push({ field: 'destination.address', requested: `funder ${BITREFILL_FUNDER}`, live: liveAddress });
    }
    const f = payment?.metadata?.bitrefill;
    const facts = f && typeof f === 'object' && !Array.isArray(f) ? f : null;
    if (!facts) {
      drift.push({ field: 'metadata.bitrefill', requested: 'frozen invoice facts', live: null });
    } else {
      if (Number(facts.v) !== 1) drift.push({ field: 'metadata.bitrefill.v', requested: 1, live: facts.v ?? null });
      // The funder pays only against a complete, bound fact set: the expiry
      // must be readable and the binding present (its HMAC is checked by the
      // funder; this CLI cannot, and does not need to, verify it).
      if (parseDeadline(facts.expiresAt) === null) {
        drift.push({ field: 'metadata.bitrefill.expiresAt', requested: 'ISO timestamp', live: facts.expiresAt ?? null });
      }
      if (typeof facts.binding !== 'string' || !/^[0-9a-f]{64}$/i.test(facts.binding)) {
        drift.push({ field: 'metadata.bitrefill.binding', requested: 'hex HMAC-SHA256', live: facts.binding ?? null });
      }
      if (!sameInvoiceId(facts.invoiceId, requested.invoiceId)) {
        drift.push({ field: 'metadata.bitrefill.invoiceId', requested: requested.invoiceId, live: facts.invoiceId ?? null });
      }
      if (!sameAddress(facts.address, requested.address)) {
        drift.push({ field: 'metadata.bitrefill.address', requested: requested.address, live: facts.address ?? null });
      }
      const amountAtomic = atomicField(facts.amountAtomic);
      if (invoiceAtomic === null || amountAtomic === null || amountAtomic !== invoiceAtomic) {
        drift.push({ field: 'metadata.bitrefill.amountAtomic', requested: invoiceAtomic?.toString() ?? null, live: facts.amountAtomic ?? null });
      }
      if (facts.feeBps !== BITREFILL_FEE_BPS) {
        drift.push({ field: 'metadata.bitrefill.feeBps', requested: BITREFILL_FEE_BPS, live: facts.feeBps ?? null });
      }
      const feeAtomic = atomicField(facts.serviceFeeAtomic);
      const payAtomic = atomicField(facts.callerPaysAtomic);
      if (invoiceAtomic !== null) {
        const wantFee = serviceFeeAtomicFor(invoiceAtomic, BITREFILL_FEE_BPS);
        const wantPay = invoiceAtomic + wantFee;
        if (feeAtomic === null || feeAtomic !== wantFee) {
          drift.push({ field: 'metadata.bitrefill.serviceFeeAtomic', requested: wantFee.toString(), live: facts.serviceFeeAtomic ?? null });
        }
        if (payAtomic === null || payAtomic !== wantPay) {
          drift.push({ field: 'metadata.bitrefill.callerPaysAtomic', requested: wantPay.toString(), live: facts.callerPaysAtomic ?? null });
        }
        const liveDest = usdcAtomic(dest.amount);
        if (liveDest === null || liveDest !== wantPay) {
          drift.push({ field: 'destination.amount', requested: atomicToUsdc(wantPay), live: dest.amount ?? null });
        }
        livePricing = {
          original: atomicToUsdc(invoiceAtomic),
          serviceFee: atomicToUsdc(wantFee),
          feeBps: BITREFILL_FEE_BPS,
          callerPays: atomicToUsdc(wantPay),
          callerPaysAtomicUsdc: wantPay.toString(),
        };
      }
    }
  }
  return drift.length
    ? {
        ok: false,
        code: 'BITREFILL_ECHO_MISMATCH',
        reason:
          model === 'funder'
            ? 'The live order does not pay this Bitrefill invoice (funder or frozen invoice facts differ). Refusing to continue.'
            : 'The live order does not deliver to the Bitrefill invoice. Refusing to continue.',
        drift,
        addressVerified: false,
        model,
        livePricing: null,
      }
    : { ok: true, code: null, reason: null, drift, addressVerified: true, model, livePricing };
}

const ROUTER_FEE_FIELDS = ['original', 'serviceFee', 'feeBps', 'callerPays', 'callerPaysAtomicUsdc'];
const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * Bitrefill service fee, read from the router's fee fields exactly as the
 * OpenRouter (Coinbase) line reads them (`original`, `serviceFee`, `feeBps`,
 * `callerPays`, plus `callerPaysAtomicUsdc`), and checked with the same
 * checkPricing guard: fee = original x feeBps rounded UP to the cent,
 * callerPays = original + serviceFee exactly.
 *
 * Compatibility (deliberate): a router response with NONE of the fee fields is
 * a zero-fee order from the current direct model, accepted only when the live
 * order is a direct-model order. A response with SOME fee fields, or fee
 * fields that do not add up, is refused. A response with fee fields must have
 * feeBps 100, callerPaysAtomicUsdc equal to callerPays, original equal to the
 * invoice, and must match what the live order (verifyBitrefillDestination's
 * livePricing) will actually charge.
 *
 * For a stablecoin deposit the deposit must cover callerPays; the rest is the
 * bridge fee, shown separately, so no part of the deposit is unexplained.
 *
 * @returns {{ok:true, pricing:{model, original, serviceFee, feeBps, callerPays, callerPaysAtomicUsdc, bridgeFee}} |
 *           {ok:false, code:'BITREFILL_FEE_MISMATCH', reason, details}}
 */
export function checkBitrefillPricing({ invoiceAmount, routerPricing = null, live, source }) {
  const bad = (reason, details = {}) => ({ ok: false, code: 'BITREFILL_FEE_MISMATCH', reason, details });
  if (!live?.ok || !live.livePricing) return bad('The live order could not be priced; refusing to show a deposit.');
  const lp = live.livePricing;
  // routerPricing === null: no router view at all (resume from the order id).
  // The live order alone then decides, and its own checks above already ran.
  const r = routerPricing && typeof routerPricing === 'object' ? routerPricing : {};
  const present = ROUTER_FEE_FIELDS.filter((k) => given(r[k]));

  if (routerPricing === null) {
    // nothing to compare
  } else if (present.length === 0) {
    // Current production router (direct model): no fee fields, no fee.
    if (live.model !== 'direct' || lp.feeBps !== 0) {
      return bad('The router stated no service fee, but the live order charges one. Refusing to continue.', { model: live.model });
    }
  } else {
    const missing = ROUTER_FEE_FIELDS.filter((k) => !given(r[k]));
    if (missing.length) {
      return bad('The router sent only part of the fee figures. Refusing to guess the price.', { missing });
    }
    const checked = checkPricing(r);
    if (!checked.ok) return bad(checked.reason, { field: checked.field, value: checked.value });
    const p = checked.pricing;
    if (p.feeBps !== BITREFILL_FEE_BPS) {
      return bad(`A Bitrefill order must carry a ${BITREFILL_FEE_BPS} bps service fee; the router stated ${r.feeBps} bps.`, { feeBps: r.feeBps });
    }
    const atomic = atomicField(r.callerPaysAtomicUsdc);
    if (atomic === null || atomicToUsdc(atomic) !== p.callerPays) {
      return bad('callerPaysAtomicUsdc does not equal callerPays.', { callerPays: r.callerPays, callerPaysAtomicUsdc: r.callerPaysAtomicUsdc });
    }
    if (normalizeDecimal(p.original) !== normalizeDecimal(invoiceAmount)) {
      return bad(`The router priced ${p.original} USDC, but the invoice is ${invoiceAmount} USDC.`, { original: r.original });
    }
    const drift = [];
    for (const k of ['original', 'serviceFee', 'callerPays']) {
      if (normalizeDecimal(p[k]) !== normalizeDecimal(lp[k])) drift.push({ field: k, router: r[k], order: lp[k] });
    }
    if (p.feeBps !== lp.feeBps) drift.push({ field: 'feeBps', router: r.feeBps, order: lp.feeBps });
    if (drift.length) return bad("The router's fee figures differ from the live order.", { drift, model: live.model });
  }

  const pricing = { model: live.model, ...lp, bridgeFee: null };
  const token = String(source?.tokenSymbol ?? '').toUpperCase();
  const stable = String(source?.chainId) !== 'lightning' && (token === 'USDC' || token === 'USDT');
  if (stable) {
    const dep = dec18(source?.amount);
    const need = dec18(lp.callerPays);
    if (dep === null || need === null || dep < need) {
      return bad('The deposit does not cover the invoice plus the service fee.', { deposit: source?.amount ?? null, callerPays: lp.callerPays });
    }
    pricing.bridgeFee = fmt18(dep - need);
  }
  return { ok: true, pricing };
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
 * The invoice an order says it pays, for a resume with no local record:
 * the frozen facts of a funder-model order, or the direct order's own
 * destination. Verifying an order against this proves its internal
 * consistency (funder, fee math), not that it is the invoice the user meant.
 */
export function bitrefillRequestedFromOrder(payment) {
  const meta = payment?.metadata || {};
  if (isBitrefillFunderOrder(payment)) {
    const f = meta.bitrefill && typeof meta.bitrefill === 'object' ? meta.bitrefill : {};
    const a = atomicField(f.amountAtomic);
    return { invoiceId: f.invoiceId ?? null, address: f.address ?? null, amount: a === null ? null : atomicToUsdc(a) };
  }
  const dest = payment?.destination || {};
  return { invoiceId: meta.bitrefillInvoiceId ?? null, address: dest.receiverAddress ?? dest.address ?? null, amount: dest.amount ?? null };
}

/**
 * A live pricing that differs from the one recorded (and confirmed) at create
 * is a refusal at send time. A record without pricing predates the fee, so it
 * only ever confirmed a zero-fee order.
 */
export function bitrefillPricingDrift(recorded, livePricing) {
  const want = recorded ?? { serviceFee: '0', feeBps: 0, callerPays: null };
  const drift = [];
  if (!livePricing) return [{ field: 'pricing', recorded: want, live: null }];
  if (normalizeDecimal(String(want.serviceFee ?? '0')) !== normalizeDecimal(livePricing.serviceFee)) {
    drift.push({ field: 'serviceFee', recorded: want.serviceFee ?? '0', live: livePricing.serviceFee });
  }
  if (Number(want.feeBps ?? 0) !== livePricing.feeBps) drift.push({ field: 'feeBps', recorded: want.feeBps ?? 0, live: livePricing.feeBps });
  if (want.callerPays !== null && want.callerPays !== undefined &&
      normalizeDecimal(String(want.callerPays)) !== normalizeDecimal(livePricing.callerPays)) {
    drift.push({ field: 'callerPays', recorded: want.callerPays, live: livePricing.callerPays });
  }
  return drift;
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
  return earliestExpiry(payment?.metadata?.bitrefillExpiresAt, payment?.metadata?.bitrefill?.expiresAt);
}
