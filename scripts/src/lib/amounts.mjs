/**
 * Amount handling for rozo-checkout.
 *
 * All comparisons between "how much we asked for" and "how much arrived" are
 * done on integer atomic units (BigInt), never on floats. Decimal places are
 * per (chain, token) — notably BSC USDT/USDC are 18-decimals while the same
 * symbols are 6-decimals everywhere else, and Stellar assets carry 7.
 *
 * Lightning is special: the backend reports integer satoshis and flags this
 * with `source.amountUnit === "sats"`. Those values must never be run through
 * BTC decimals nor labelled "X BTC" (PLAN §3, fix P1-8).
 */

export const CHAIN_IDS = {
  ethereum: '1',
  bnb: '56',
  polygon: '137',
  base: '8453',
  arbitrum: '42161',
  solana: '900',
  stellar: '1500',
  lightning: 'lightning',
};

export const CHAIN_NAMES = {
  1: 'Ethereum',
  56: 'BNB Chain',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum',
  900: 'Solana',
  1500: 'Stellar',
  lightning: 'Bitcoin Lightning',
};

/** Chain families drive address normalization and signing backends. */
export const CHAIN_FAMILY = {
  1: 'evm',
  56: 'evm',
  137: 'evm',
  8453: 'evm',
  42161: 'evm',
  900: 'solana',
  1500: 'stellar',
  lightning: 'lightning',
};

/**
 * Server-side source whitelist (PLAN §2). Lightning lives outside the
 * server's SUPPORTED_SOURCE payload, so we carry it locally (fix P1-13).
 *
 * Native coins (ETH, BNB, POL, SOL) are listed after the stablecoins on their
 * chain. They are accepted here, but an order for one is only created when the
 * router's quote-invoice lists it in `supportedSources` for that invoice (see
 * nativeOfferFor), and only inside the native USD bounds.
 */
export const SUPPORTED_SOURCES = [
  { chainId: '1', chain: 'Ethereum', tokens: ['USDC', 'USDT', 'ETH'] },
  { chainId: '56', chain: 'BNB Chain', tokens: ['USDC', 'USDT', 'BNB'] },
  { chainId: '137', chain: 'Polygon', tokens: ['USDC', 'USDT', 'POL'] },
  { chainId: '900', chain: 'Solana', tokens: ['USDC', 'USDT', 'SOL'] },
  { chainId: '8453', chain: 'Base', tokens: ['USDC', 'ETH'] },
  { chainId: '42161', chain: 'Arbitrum', tokens: ['USDC', 'USDT', 'ETH'] },
  { chainId: '1500', chain: 'Stellar', tokens: ['USDC'] },
  { chainId: 'lightning', chain: 'Bitcoin Lightning', tokens: ['BTC'] },
];

/**
 * The chain's own coin, keyed `${chainId}:${SYMBOL}`. A native order is
 * exact-out like Lightning: source.amount is the exact coin amount to send, the
 * price is locked only until quoteExpiresAt, and it is sent as a plain value
 * transfer (EVM) or a System Program transfer (Solana), never as a token.
 */
export const NATIVE_COINS = Object.freeze({
  '1:ETH': { chainId: '1', symbol: 'ETH', decimals: 18 },
  '8453:ETH': { chainId: '8453', symbol: 'ETH', decimals: 18 },
  '42161:ETH': { chainId: '42161', symbol: 'ETH', decimals: 18 },
  '56:BNB': { chainId: '56', symbol: 'BNB', decimals: 18 },
  '137:POL': { chainId: '137', symbol: 'POL', decimals: 18 },
  '900:SOL': { chainId: '900', symbol: 'SOL', decimals: 9 },
});

/** Backend limit on one native order, in USD (rozo-intents-api MAX_NATIVE_PAYIN_USD). */
export const NATIVE_MAX_USD = 2000;

/**
 * Fallback USD minimum per native coin, used only when the quote does not
 * carry its own `nativeMinUsd`. Native ETH on Ethereum needs $1 because of gas.
 */
export const NATIVE_MIN_USD_FALLBACK = Object.freeze({ '1:ETH': 1 });

/** Per-(chain, token) decimals. Keys are `${chainId}:${SYMBOL}`. */
const DECIMALS = {
  '1:USDC': 6,
  '1:USDT': 6,
  // BNB Chain: BEP-20 USDT and USDC are both 18-decimals.
  '56:USDC': 18,
  '56:USDT': 18,
  '137:USDC': 6,
  '137:USDT': 6,
  '8453:USDC': 6,
  // Arbitrum One: native USDC and USDT0 are both 6-decimals.
  '42161:USDC': 6,
  '42161:USDT': 6,
  '900:USDC': 6,
  '900:USDT': 6,
  // Stellar classic assets carry 7 decimal places.
  '1500:USDC': 7,
  // Native coins: wei (18) on every EVM chain, lamports (9) on Solana.
  '1:ETH': 18,
  '8453:ETH': 18,
  '42161:ETH': 18,
  '56:BNB': 18,
  '137:POL': 18,
  '900:SOL': 9,
};

export class AmountError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Case/space-insensitive lookup key. */
export function decimalsKey(chainId, tokenSymbol) {
  return `${String(chainId).trim()}:${String(tokenSymbol || '').trim().toUpperCase()}`;
}

/**
 * Decimals for a (chain, token) pair. Lightning has no decimals — callers must
 * branch on `isSatsUnit` before ever asking.
 */
export function decimalsFor(chainId, tokenSymbol) {
  const key = decimalsKey(chainId, tokenSymbol);
  const d = DECIMALS[key];
  if (d === undefined) {
    throw new AmountError(
      'UNKNOWN_DECIMALS',
      `No decimals known for ${key}; refusing to guess.`,
    );
  }
  return d;
}

/** True when the backend flagged the amount as integer satoshis. */
export function isSatsUnit(amountUnit) {
  return String(amountUnit || '').trim().toLowerCase() === 'sats';
}

/**
 * Convert a decimal string ("1.234500") to atomic integer units as BigInt.
 * Rejects anything that is not a plain non-negative decimal, and rejects
 * values with more fractional digits than the token can represent (silently
 * truncating money is how under-payments get mislabelled as exact).
 */
export function toAtomic(decimalString, decimals) {
  if (typeof decimalString === 'number') decimalString = String(decimalString);
  if (typeof decimalString !== 'string') {
    throw new AmountError('BAD_AMOUNT', 'Amount must be a string or number.');
  }
  const s = decimalString.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new AmountError('BAD_AMOUNT', `Not a plain decimal amount: ${s}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AmountError('BAD_DECIMALS', `Invalid decimals: ${decimals}`);
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    // Allow trailing zeros beyond precision, reject real precision loss.
    const excess = frac.slice(decimals);
    if (/[^0]/.test(excess)) {
      throw new AmountError(
        'AMOUNT_PRECISION',
        `Amount ${s} has more precision than ${decimals} decimals allow.`,
      );
    }
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole + (decimals > 0 ? padded : ''));
}

/** Parse an integer satoshi amount. */
export function satsToAtomic(value) {
  const s = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+$/.test(s)) {
    throw new AmountError('BAD_SATS', `Lightning amount must be integer sats: ${s}`);
  }
  return BigInt(s);
}

/**
 * Atomic units for a backend `source` block, honoring amountUnit === "sats".
 * `field` is which value to read ("amount" or "amountReceived").
 */
export function sourceAtomic(source, field) {
  const raw = source?.[field];
  if (raw === null || raw === undefined || raw === '') return null;
  if (isSatsUnit(source?.amountUnit)) return satsToAtomic(raw);
  return toAtomic(raw, decimalsFor(source?.chainId, source?.tokenSymbol));
}

/**
 * Compare received vs expected. Returns one of:
 *   { state: "none" | "underpaid" | "exact" | "overpaid", expected, received, delta }
 * Values in the result are decimal strings of BigInt atomic units.
 * Never auto-tops-up an underpayment; never attempts a client-side refund
 * (PLAN §3, fix R2-P1).
 */
export function comparePayment(source) {
  const expected = sourceAtomic(source, 'amount');
  if (expected === null) {
    throw new AmountError('MISSING_EXPECTED_AMOUNT', 'source.amount is missing.');
  }
  const received = sourceAtomic(source, 'amountReceived');
  if (received === null || received === 0n) {
    return {
      state: 'none',
      expectedAtomic: expected.toString(),
      receivedAtomic: (received ?? 0n).toString(),
      deltaAtomic: (0n - expected).toString(),
    };
  }
  const delta = received - expected;
  return {
    state: delta === 0n ? 'exact' : delta < 0n ? 'underpaid' : 'overpaid',
    expectedAtomic: expected.toString(),
    receivedAtomic: received.toString(),
    deltaAtomic: delta.toString(),
  };
}

/** Human display unit for an amount, never inventing "BTC" for sats. */
export function formatAmount(source) {
  const amount = source?.amount;
  if (isSatsUnit(source?.amountUnit)) return `${amount} sats`;
  return `${amount} ${source?.tokenSymbol ?? ''}`.trim();
}

/** Human chain label from a chainId. */
export function chainName(chainId) {
  return CHAIN_NAMES[String(chainId)] || CHAIN_NAMES[chainId] || `chain ${chainId}`;
}

/**
 * The Stellar memo type this backend uses, everywhere, for every order.
 *
 * Verified in rozo-intents-api rather than inferred: the settle path writes
 * `memo_type: 'text'` (shared/stellar-direct-settle.ts), the payment API
 * records `memo_type: verification.memo ? 'text' : 'none'`, validation is
 * `isValidMemoText` bounded by a 28-byte MEMO_TEXT limit, per-intent memos are
 * generated as "a STRONG ... Stellar MEMO_TEXT" of the form `rz` + Crockford
 * base32 — which Memo.id() would reject outright — and monitor-stellar matches
 * by plain string equality on source_receiver_memo.
 *
 * A memo that looks numeric (e.g. 65371582) is still TEXT. Sending it as
 * MEMO_ID produces a different memo hash and the payment will not match.
 */
export const STELLAR_MEMO_TYPE = 'MEMO_TEXT';

/** Family ("evm" | "solana" | "stellar" | "lightning") for a chainId. */
export function chainFamily(chainId) {
  return CHAIN_FAMILY[String(chainId)] || CHAIN_FAMILY[chainId] || null;
}

/** True when the (chain, token) pair is in the documented whitelist. */
export function isSupportedSource(chainId, tokenSymbol) {
  const cid = String(chainId).trim();
  const sym = String(tokenSymbol || '').trim().toUpperCase();
  return SUPPORTED_SOURCES.some((s) => s.chainId === cid && s.tokens.includes(sym));
}

/** True when (chain, token) is the chain's own coin rather than a token. */
export function isNativeSource(chainId, tokenSymbol) {
  return Object.prototype.hasOwnProperty.call(NATIVE_COINS, decimalsKey(chainId, tokenSymbol));
}

/**
 * Every spelling of "the chain's native coin" the backend uses as a
 * tokenAddress: absent, the EVM zero address, the 0xEeee... sentinel, or
 * "native" (Solana). Anything else on a native order is a contract or mint we
 * did not expect, and the send scripts refuse it.
 */
const NATIVE_TOKEN_ADDRESSES = new Set([
  '',
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'native',
  '11111111111111111111111111111111',
]);

export function isNativeTokenAddress(tokenAddress) {
  if (tokenAddress === null || tokenAddress === undefined) return true;
  return NATIVE_TOKEN_ADDRESSES.has(String(tokenAddress).trim().toLowerCase());
}

/**
 * USD minimum for a native coin on this invoice: the quote's own
 * `nativeMinUsd` (shaped { "<chainId>": { "<SYMBOL>": number } }) when it says,
 * else NATIVE_MIN_USD_FALLBACK, else null (no minimum known).
 */
export function nativeMinUsdFor(chainId, tokenSymbol, quoteNativeMinUsd) {
  const cid = String(chainId).trim();
  const sym = String(tokenSymbol || '').trim().toUpperCase();
  const fromQuote = quoteNativeMinUsd?.[cid]?.[sym];
  const n = Number(fromQuote);
  if (fromQuote !== undefined && fromQuote !== null && Number.isFinite(n) && n > 0) return n;
  return NATIVE_MIN_USD_FALLBACK[`${cid}:${sym}`] ?? null;
}

/**
 * Is this native coin on offer for this invoice? It must be listed in the
 * router's quote-invoice `supportedSources` ({ "<chainId>": ["USDC", "ETH"] })
 * and the invoice must sit inside the native USD bounds. A missing or
 * malformed supportedSources means "not offered": native coins are never
 * assumed.
 *
 * @returns {{ok:boolean, code:string|null, reason:string|null, minUsd:number|null}}
 */
export function nativeOfferFor({ chainId, tokenSymbol, supportedSources, nativeMinUsd, callerPaysUsd }) {
  const cid = String(chainId).trim();
  const sym = String(tokenSymbol || '').trim().toUpperCase();
  const label = `${sym} on ${chainName(cid)}`;
  const minUsd = nativeMinUsdFor(cid, sym, nativeMinUsd);
  if (!isNativeSource(cid, sym)) {
    return { ok: false, code: 'NOT_NATIVE', reason: `${label} is not a native coin.`, minUsd: null };
  }
  const list = supportedSources && typeof supportedSources === 'object' ? supportedSources[cid] : null;
  if (!Array.isArray(list) || !list.map((t) => String(t).toUpperCase()).includes(sym)) {
    return {
      ok: false,
      code: 'NATIVE_NOT_OFFERED',
      reason: `${label} is not offered for this invoice. Pay with USDC or USDT instead.`,
      minUsd,
    };
  }
  const usd = Number(callerPaysUsd);
  if (Number.isFinite(usd) && usd > 0) {
    if (usd > NATIVE_MAX_USD) {
      return {
        ok: false,
        code: 'NATIVE_AMOUNT_TOO_HIGH',
        reason: `Native coin orders are limited to $${NATIVE_MAX_USD} per invoice; this one is $${usd}. Pay with USDC or USDT instead.`,
        minUsd,
      };
    }
    if (minUsd !== null && usd < minUsd) {
      return {
        ok: false,
        code: 'NATIVE_AMOUNT_TOO_LOW',
        reason: `${label} needs an invoice of at least $${minUsd}; this one is $${usd}. Pay with another coin.`,
        minUsd,
      };
    }
  }
  return { ok: true, code: null, reason: null, minUsd };
}
