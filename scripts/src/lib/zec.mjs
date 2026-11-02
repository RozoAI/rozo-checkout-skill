/**
 * Shielded Zcash (ZEC) orders. Pure helpers: no I/O, no network.
 *
 * The CLI creates a shielded ZEC order through the router and shows the
 * payer the pool Unified Address, the exact amount and the ZIP-321 payment
 * URI (the QR content). It never holds a Zcash wallet and never sends ZEC:
 * the payer pays from their own shielded wallet (Zashi or similar).
 *
 * Contract (router, live since 2026-11-02): quote-invoice and create-invoice
 * accept `?beta=zec,zec_shielded`; the quote then lists ZEC in
 * `supportedSources["9133"]` and `sourceMeta["ZEC@9133"].shieldedAvailable`.
 * create-invoice with `source: { chainId: "9133", tokenSymbol: "ZEC",
 * shielded: true }` creates the shielded order; the live payment carries
 * `source.receiverAddress` (u1...), `source.amount` (ZEC, exact-out),
 * `source.paymentUri` (ZIP-321) and `source.zec` { receive, payinState,
 * confirmations, requiredConfirmations, quoteExpiresAt }.
 */

export const ZEC_CHAIN_ID = '9133';
export const ZEC_SYMBOL = 'ZEC';
export const ZEC_SOURCE_META_KEY = 'ZEC@9133';
/** Both quote-invoice and create-invoice must carry this opt-in. */
export const ZEC_BETA_PARAM = 'zec,zec_shielded';
/** Beta limit per payment (router ZEC_SHIELDED_MAX_USD). */
export const ZEC_SHIELDED_MAX_USD = 1200;
/** Router minimum for a ZEC pay-in. */
export const ZEC_MIN_USD = 5;
/** Confirmations the custody rail waits for before it advances the merchant. */
export const ZEC_TWO_CONF_FROM_USD = 110;
export const ZEC_PAYIN_STATES = new Set(['awaiting', 'seen', 'confirming', 'eligible', 'expired', 'reorged']);

const UA_RE = /^u1[02-9ac-hj-np-z]{100,400}$/;

/** True for ZEC on Zcash, in any spelling. */
export function isZecSource(chainId, tokenSymbol) {
  return String(chainId ?? '').trim() === ZEC_CHAIN_ID && String(tokenSymbol ?? '').trim().toUpperCase() === ZEC_SYMBOL;
}

/** Mainnet Unified Address shape (bech32m charset, u1 prefix). Shape only. */
export function isUnifiedAddress(value) {
  return typeof value === 'string' && UA_RE.test(value.trim());
}

/** 1 confirmation under $110, 2 from $110 (mirrors the custody rail). */
export function zecRequiredConfirmations(usd) {
  const n = Number(usd);
  return Number.isFinite(n) && n >= ZEC_TWO_CONF_FROM_USD ? 2 : 1;
}

/**
 * Is a shielded ZEC order on offer for this invoice? Needs the router to list
 * ZEC for this invoice, to flag shielded as available, and the invoice to sit
 * inside the beta bounds. Nothing is assumed when a field is missing.
 *
 * @returns {{ok:boolean, code:string|null, reason:string|null, requiredConfirmations:number|null}}
 */
export function zecShieldedOfferFor({ supportedSources, sourceMeta, callerPaysUsd }) {
  const list = supportedSources && typeof supportedSources === 'object' ? supportedSources[ZEC_CHAIN_ID] : null;
  if (!Array.isArray(list) || !list.map((t) => String(t).toUpperCase()).includes(ZEC_SYMBOL)) {
    return {
      ok: false,
      code: 'ZEC_NOT_OFFERED',
      reason: 'ZEC is not offered for this invoice. Pay with USDC or USDT instead.',
      requiredConfirmations: null,
    };
  }
  const meta = sourceMeta && typeof sourceMeta === 'object' ? sourceMeta[ZEC_SOURCE_META_KEY] : null;
  const available = meta && typeof meta === 'object' && (meta.shieldedAvailable === true || meta.shielded_available === true);
  if (!available) {
    return {
      ok: false,
      code: 'ZEC_SHIELDED_NOT_AVAILABLE',
      reason: 'Paying from a shielded balance is not available for this invoice right now.',
      requiredConfirmations: null,
    };
  }
  const usd = Number(callerPaysUsd);
  if (!Number.isFinite(usd) || usd <= 0) {
    return {
      ok: false,
      code: 'ZEC_AMOUNT_UNKNOWN',
      reason: 'The quote carries no USD amount, so the shielded ZEC limits cannot be checked. Pay with USDC or USDT instead.',
      requiredConfirmations: null,
    };
  }
  if (usd > ZEC_SHIELDED_MAX_USD) {
    return {
      ok: false,
      code: 'ZEC_AMOUNT_TOO_HIGH',
      reason: `Shielded ZEC is limited to $${ZEC_SHIELDED_MAX_USD} per payment during the beta; this invoice is $${usd}. Pay with USDC or USDT instead.`,
      requiredConfirmations: null,
    };
  }
  if (usd < ZEC_MIN_USD) {
    return {
      ok: false,
      code: 'ZEC_AMOUNT_TOO_LOW',
      reason: `ZEC payments need an invoice of at least $${ZEC_MIN_USD}; this one is $${usd}. Pay with another coin.`,
      requiredConfirmations: null,
    };
  }
  return { ok: true, code: null, reason: null, requiredConfirmations: zecRequiredConfirmations(usd) };
}

/** The `source.zec` block of a live payment, validated field by field, or null. */
export function zecStatusOf(source) {
  const z = source?.zec;
  if (!z || typeof z !== 'object') return null;
  const receive = z.receive === 'shielded' || z.receive === 'transparent' ? z.receive : null;
  const payinState = ZEC_PAYIN_STATES.has(z.payinState) ? z.payinState : null;
  const confirmations = Number.isInteger(z.confirmations) && z.confirmations >= 0 ? z.confirmations : null;
  const requiredConfirmations = z.requiredConfirmations === 1 || z.requiredConfirmations === 2 ? z.requiredConfirmations : null;
  const quoteExpiresAt = typeof z.quoteExpiresAt === 'string' && z.quoteExpiresAt ? z.quoteExpiresAt : null;
  const receivedZat = typeof z.receivedZat === 'string' && /^\d+$/.test(z.receivedZat) ? z.receivedZat : null;
  return { receive, payinState, confirmations, requiredConfirmations, quoteExpiresAt, receivedZat };
}

/**
 * Money-detected rule for a ZEC custody order: the rail reports a pay-in in
 * `source.zec` before (and independently of) `amountReceived` / `txHash`. A
 * sighting (`seen`), a confirming or settled pay-in, or any received zatoshi
 * is money, and nobody may be told to pay again. Unknown state fails closed.
 */
export function zecMoneySeen(zec) {
  if (!zec) return false;
  if (zec.payinState === 'seen' || zec.payinState === 'confirming' || zec.payinState === 'eligible') return true;
  if (zec.receivedZat !== null && zec.receivedZat !== '0') return true;
  if (zec.payinState === null) return true;
  return false;
}

/**
 * Parse a ZIP-321 URI for ONE payment with no indexed parameters:
 *   zcash:<address>?amount=<decimal>[&memo=<base64url>]
 * Any other key, an indexed key, a duplicate, or a second payment is refused:
 * the CLI shows the URI verbatim as the QR content, so it must be exactly the
 * order and nothing else.
 */
export function parsePaymentUri(uri) {
  if (typeof uri !== 'string') return null;
  const m = /^zcash:([0-9a-z]+)\?([^#]*)$/i.exec(uri.trim());
  if (!m) return null;
  const address = m[1];
  const out = { address, amount: null, memo: null };
  const seen = new Set();
  for (const part of m[2].split('&')) {
    if (!part) return null;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === 'amount') {
      if (!/^\d+(\.\d{1,8})?$/.test(value)) return null;
      out.amount = value;
    } else if (key === 'memo') {
      if (!/^[A-Za-z0-9_-]{1,684}$/.test(value)) return null;
      out.memo = value;
    } else {
      return null;
    }
  }
  if (out.amount === null) return null;
  return out;
}

/** "0.00851258" and "0.0085125800" are the same amount. */
function sameDecimal(a, b) {
  const norm = (v) => {
    const s = String(v ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const [w, f = ''] = s.split('.');
    const frac = f.replace(/0+$/, '');
    return `${w.replace(/^0+(?=\d)/, '')}${frac ? `.${frac}` : ''}`;
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

/**
 * Check that the deposit of a shielded order is complete and consistent:
 * a Unified Address, a positive ZEC amount, and a payment URI that names
 * exactly that address and amount. Returns a verdict, never throws.
 */
export function validateShieldedDeposit(source) {
  const address = typeof source?.receiverAddress === 'string' ? source.receiverAddress.trim() : '';
  if (!isUnifiedAddress(address)) {
    return { ok: false, code: 'ZEC_ADDRESS_INVALID', reason: 'The order did not return a mainnet Unified Address (u1...). Refusing to show it as payable.' };
  }
  const uri = typeof source?.paymentUri === 'string' ? source.paymentUri.trim() : '';
  if (!uri) {
    return { ok: false, code: 'ZEC_PAYMENT_URI_MISSING', reason: 'The order carries no payment URI yet. Nothing is payable until it appears.' };
  }
  const parsed = parsePaymentUri(uri);
  if (!parsed) {
    return { ok: false, code: 'ZEC_PAYMENT_URI_INVALID', reason: 'The payment URI is not a single-payment ZIP-321 URI. Refusing to show it.' };
  }
  if (parsed.address !== address) {
    return { ok: false, code: 'ZEC_PAYMENT_URI_MISMATCH', reason: 'The payment URI names a different address than the order. Refusing to show it.' };
  }
  if (!sameDecimal(parsed.amount, source?.amount)) {
    return { ok: false, code: 'ZEC_PAYMENT_URI_MISMATCH', reason: 'The payment URI amount differs from the order amount. Refusing to show it.' };
  }
  return { ok: true, code: null, reason: null, address, paymentUri: uri, memo: parsed.memo };
}

/** Warnings shown with every shielded deposit block. */
export function zecDepositWarnings({ requiredConfirmations }) {
  return [
    'Pay from a shielded balance, in ONE transaction, exactly the amount shown. The price is locked only until the time shown; after that, do not send, start a new order.',
    'Underpayments are not refunded automatically: a short payment is held for support, not credited.',
    `Scan the payment URI (QR content) with a shielded wallet such as Zashi; it carries the address, the amount and the order memo. Do not edit any of them.`,
    `The merchant is paid after ${requiredConfirmations ?? 1} confirmation${requiredConfirmations === 2 ? 's' : ''} (about 75 seconds each).`,
    `Beta: up to $${ZEC_SHIELDED_MAX_USD} per payment.`,
  ];
}
