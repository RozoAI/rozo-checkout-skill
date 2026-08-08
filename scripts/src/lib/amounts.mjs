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
  solana: '900',
  stellar: '1500',
  lightning: 'lightning',
};

export const CHAIN_NAMES = {
  1: 'Ethereum',
  56: 'BNB Chain',
  137: 'Polygon',
  8453: 'Base',
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
  900: 'solana',
  1500: 'stellar',
  lightning: 'lightning',
};

/**
 * Server-side source whitelist (PLAN §2). Lightning lives outside the
 * server's SUPPORTED_SOURCE payload, so we carry it locally (fix P1-13).
 */
export const SUPPORTED_SOURCES = [
  { chainId: '1', chain: 'Ethereum', tokens: ['USDC', 'USDT'] },
  { chainId: '56', chain: 'BNB Chain', tokens: ['USDC', 'USDT'] },
  { chainId: '137', chain: 'Polygon', tokens: ['USDC', 'USDT'] },
  { chainId: '900', chain: 'Solana', tokens: ['USDC', 'USDT'] },
  { chainId: '8453', chain: 'Base', tokens: ['USDC'] },
  { chainId: '1500', chain: 'Stellar', tokens: ['USDC'] },
  { chainId: 'lightning', chain: 'Bitcoin Lightning', tokens: ['BTC'] },
];

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
  '900:USDC': 6,
  '900:USDT': 6,
  // Stellar classic assets carry 7 decimal places.
  '1500:USDC': 7,
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
