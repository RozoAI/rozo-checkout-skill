/**
 * x402 payer: pure helpers. No I/O, no network, no clock unless passed in.
 *
 * What lives here:
 *   - parsing a 402 challenge (x402 v2 PAYMENT-REQUIRED header, x402 v1 JSON body)
 *   - deciding which `accepts` entries this payer can settle (scheme "exact",
 *     USDC on Base only; Solana USDC is recognized but not paid yet, the
 *     Solana payment leg is coming later)
 *   - choosing one option inside the caller's budget
 *   - decoding the PAYMENT-RESPONSE settlement header
 *   - the topup coin presets (USDC and USDT only; native coins and Lightning
 *     are refused locally and pointed at ROZO Checkout)
 *
 * The payer never signs anything locally. Rozo holds the balance and returns
 * the PAYMENT-SIGNATURE value; this module only decides what to ask for.
 */

import { SkillError } from './output.mjs';

export const NETWORK_BASE = 'eip155:8453';
export const NETWORK_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** USDC contract / mint per supported payment network. */
export const USDC_ASSET = {
  [NETWORK_BASE]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [NETWORK_SOLANA]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
export const USDC_DECIMALS = 6;

/**
 * Networks the payer actually signs for today. Solana stays in USDC_ASSET so a
 * Solana option is still parsed and reported, but it is classified as
 * unsupported until the Solana payment leg ships.
 */
export const PAYABLE_NETWORKS = new Set([NETWORK_BASE]);
export const SOLANA_COMING_LATER = 'Solana payment leg is coming later';

/** x402 v1 used short network names; map the two we support to CAIP-2. */
const V1_NETWORK_ALIASES = {
  base: NETWORK_BASE,
  solana: NETWORK_SOLANA,
};

/** Address family for the blacklist check, per supported network. */
export function networkFamily(network) {
  if (network === NETWORK_BASE) return 'evm';
  if (network === NETWORK_SOLANA) return 'solana';
  return null;
}

export function networkLabel(network) {
  if (network === NETWORK_BASE) return 'Base';
  if (network === NETWORK_SOLANA) return 'Solana';
  return String(network);
}

/** Decode a base64 (or base64url) JSON header value. Returns null on any defect. */
export function decodeBase64Json(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse a 402 response into a challenge.
 *
 *   x402 v2: `PAYMENT-REQUIRED` header, base64 JSON
 *            { x402Version: 2, resource, accepts: [{ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }] }
 *   x402 v1: JSON body { x402Version: 1, accepts: [{ scheme, network, maxAmountRequired, asset, payTo, ... }] }
 *
 * The v2 header wins when both are present. Throws X402_BAD_CHALLENGE when the
 * response is a 402 without a usable challenge.
 *
 * `getHeader` is a function (name) => string|null, so this works with a fetch
 * Headers object or a plain map in tests.
 */
export function parseChallenge({ status, getHeader, bodyText }) {
  if (status !== 402) {
    throw new SkillError('X402_NOT_402', `Expected HTTP 402, got ${status}.`);
  }
  const headerValue = getHeader('payment-required');
  let doc = headerValue ? decodeBase64Json(headerValue) : null;
  let source = doc ? 'header' : null;
  if (!doc) {
    doc = parseJsonText(bodyText);
    source = doc ? 'body' : null;
  }
  if (!doc || !Array.isArray(doc.accepts) || doc.accepts.length === 0) {
    throw new SkillError(
      'X402_BAD_CHALLENGE',
      'The endpoint returned 402 but no x402 payment requirements (no PAYMENT-REQUIRED header and no accepts list in the body).',
    );
  }
  const x402Version = Number(doc.x402Version) || (source === 'header' ? 2 : 1);
  return {
    x402Version,
    source,
    resource: doc.resource ?? null,
    error: typeof doc.error === 'string' ? doc.error : null,
    extensions: doc.extensions ?? null,
    accepts: doc.accepts,
  };
}

/** Atomic amount of one requirement as a BigInt, or null when unparsable. */
function atomicAmount(req) {
  const raw = req?.amount ?? req?.maxAmountRequired;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  return BigInt(s);
}

/** Format atomic USDC as a decimal string, no trailing zeros past cents. */
export function formatUsdc(atomic) {
  const a = BigInt(atomic);
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const fracOut = frac.length < 2 ? frac.padEnd(2, '0') : frac;
  return `${whole}.${fracOut}`;
}

/** Parse a USD decimal like "0.50" into atomic USDC. Throws on anything else. */
export function usdToAtomic(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new SkillError('BAD_VALUE', `"${value}" is not a USD amount like 0.50.`);
  }
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(USDC_DECIMALS, '0'));
}

/**
 * Normalize one `accepts` entry. Returns { supported, reason, option } where
 * option carries the CAIP-2 network, the atomic amount, and the untouched
 * original entry (sent back to Rozo verbatim so its hash matches the seller's).
 */
export function classifyRequirement(req) {
  if (!req || typeof req !== 'object') return { supported: false, reason: 'not an object' };
  const network = V1_NETWORK_ALIASES[req.network] ?? req.network;
  if (req.scheme !== 'exact') {
    return { supported: false, reason: `scheme ${req.scheme} (only exact)`, network };
  }
  const usdc = USDC_ASSET[network];
  if (!usdc) {
    return { supported: false, reason: `network ${req.network} (only Base USDC)`, network };
  }
  if (!PAYABLE_NETWORKS.has(network)) {
    const reason = network === NETWORK_SOLANA ? `USDC on Solana (${SOLANA_COMING_LATER})` : `network ${req.network} (only Base USDC)`;
    return { supported: false, reason, network };
  }
  const assetOk =
    network === NETWORK_BASE
      ? String(req.asset ?? '').toLowerCase() === usdc.toLowerCase()
      : String(req.asset ?? '') === usdc;
  if (!assetOk) {
    return { supported: false, reason: `asset ${req.asset} on ${networkLabel(network)} is not USDC`, network };
  }
  const amount = atomicAmount(req);
  if (amount === null || amount <= 0n) {
    return { supported: false, reason: 'missing or invalid amount', network };
  }
  if (typeof req.payTo !== 'string' || !req.payTo.trim()) {
    return { supported: false, reason: 'missing payTo', network };
  }
  return {
    supported: true,
    option: {
      network,
      asset: req.asset,
      payTo: req.payTo,
      amountAtomic: amount,
      amountUsd: formatUsdc(amount),
      requirement: req,
    },
  };
}

/**
 * Pick the cheapest supported option within the budget.
 * `prefer` ("base" | "solana") breaks ties and wins when both fit. Only Base
 * is payable today, so the solana branch is inert until that leg ships.
 *
 * Throws:
 *   X402_UNSUPPORTED     nothing in `accepts` is exact USDC on Base
 *   X402_OVER_BUDGET     something is payable, but every option exceeds the budget
 */
export function selectRequirement(challenge, { budgetAtomic, prefer } = {}) {
  const classified = challenge.accepts.map(classifyRequirement);
  const supported = classified.filter((c) => c.supported).map((c) => c.option);
  if (supported.length === 0) {
    const solanaOffered = classified.some((c) => c.network === NETWORK_SOLANA);
    throw new SkillError(
      'X402_UNSUPPORTED',
      'This endpoint does not accept a payment Rozo can sign. Rozo pays with USDC on Base (eip155:8453, scheme exact) only.' +
        (solanaOffered ? ` It offers USDC on Solana; the ${SOLANA_COMING_LATER}.` : ''),
      { offered: classified.map((c) => c.reason ?? 'supported') },
    );
  }
  const within = supported.filter((o) => budgetAtomic === undefined || o.amountAtomic <= budgetAtomic);
  if (within.length === 0) {
    const cheapest = supported.reduce((a, b) => (b.amountAtomic < a.amountAtomic ? b : a));
    throw new SkillError(
      'X402_OVER_BUDGET',
      `The endpoint asks for ${cheapest.amountUsd} USDC, above your budget of ${formatUsdc(budgetAtomic)} USD. ` +
        'Raise --max-usd if you mean to pay that much.',
      { askedUsd: cheapest.amountUsd, budgetUsd: formatUsdc(budgetAtomic) },
    );
  }
  const preferNet = prefer === 'base' ? NETWORK_BASE : prefer === 'solana' ? NETWORK_SOLANA : null;
  within.sort((a, b) => {
    if (preferNet) {
      const pa = a.network === preferNet ? 0 : 1;
      const pb = b.network === preferNet ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    return a.amountAtomic < b.amountAtomic ? -1 : a.amountAtomic > b.amountAtomic ? 1 : 0;
  });
  return within[0];
}

/** Header the signed payload goes in: v2 PAYMENT-SIGNATURE, v1 X-PAYMENT. */
export function paymentHeaderName(x402Version) {
  return Number(x402Version) >= 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
}

/** Header the seller's settlement result comes back in. */
export function paymentResponseHeaderNames() {
  return ['payment-response', 'x-payment-response'];
}

/**
 * Pull the header value out of a /v1/x402/sign response. The contract is a
 * string ready for the PAYMENT-SIGNATURE header; a few equivalent field names
 * are tolerated so a naming drift on the server does not break payment.
 * A JSON payload object (not yet encoded) is base64-encoded here.
 */
export function extractSignature(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const direct =
    resp.paymentSignature ??
    resp.PAYMENT_SIGNATURE ??
    resp['PAYMENT-SIGNATURE'] ??
    resp.signature ??
    resp.headerValue ??
    resp.header?.value ??
    null;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (resp.paymentPayload && typeof resp.paymentPayload === 'object') {
    return encodeBase64Json(resp.paymentPayload);
  }
  return null;
}

/** Decode the seller's PAYMENT-RESPONSE into the fields an agent reports. */
export function decodeSettlement(headerValue) {
  const doc = decodeBase64Json(headerValue);
  if (!doc) return null;
  return {
    success: doc.success ?? null,
    transaction: doc.transaction ?? doc.txHash ?? null,
    network: doc.network ?? null,
    payer: doc.payer ?? null,
    errorReason: doc.errorReason ?? null,
  };
}

/**
 * Topup coin presets: USDC and USDT only, the stablecoin set the router
 * accepts on /v1/x402/topup (rozo-mpprouter STABLE_SOURCES). The router
 * refuses Lightning and native coins with X402_TOPUP_SOURCE_UNSUPPORTED;
 * those coins are for paying OpenRouter through ROZO Checkout, not for the
 * x402 balance. x402 payment itself is always USDC.
 */
export const TOPUP_PRESETS = {
  'usdt-solana': { chain: '900', token: 'USDT' },
  'usdc-solana': { chain: '900', token: 'USDC' },
  'usdt-bnb': { chain: '56', token: 'USDT' },
  'usdc-bnb': { chain: '56', token: 'USDC' },
  'usdt-ethereum': { chain: '1', token: 'USDT' },
  'usdc-ethereum': { chain: '1', token: 'USDC' },
  'usdt-polygon': { chain: '137', token: 'USDT' },
  'usdc-polygon': { chain: '137', token: 'USDC' },
  'usdt-arbitrum': { chain: '42161', token: 'USDT' },
  'usdc-arbitrum': { chain: '42161', token: 'USDC' },
  'usdc-base': { chain: '8453', token: 'USDC' },
  'usdc-stellar': { chain: '1500', token: 'USDC' },
};

/**
 * Coins that are valid for ROZO Checkout but never for an x402 top up. Named
 * here so the CLI can refuse them with a pointer instead of a generic
 * "unknown coin", and without sending a request the router would refuse.
 */
export const NON_TOPUP_PRESETS = new Set([
  'btc-lightning',
  'eth-ethereum',
  'eth-base',
  'eth-arbitrum',
  'bnb-bnb',
  'sol-solana',
]);

export const TOPUP_STABLE_ONLY =
  'x402 top ups accept USDC and USDT only. Holding a native coin or sats? Use them to top up OpenRouter with: ' +
  'rozo-checkout pay <openrouter-payment-link> --with btc-lightning (sats), or https://checkout.rozo.ai (native coins).';

export const TOPUP_MIN_USD = 5;

export function resolveTopupPreset(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (NON_TOPUP_PRESETS.has(key) || /^(eth|bnb|sol|pol|matic|xlm|btc|sats)-/.test(key)) {
    throw new SkillError('X402_TOPUP_SOURCE_UNSUPPORTED', TOPUP_STABLE_ONLY, { preset: key });
  }
  const hit = TOPUP_PRESETS[key];
  if (!hit) {
    throw new SkillError(
      'BAD_PRESET',
      `"${value}" is not a topup coin. Known: ${Object.keys(TOPUP_PRESETS).join(', ')}`,
    );
  }
  return { preset: key, ...hit };
}

/** Mask an agent key for display: prefix and last 4 only. */
export function maskKey(key) {
  const s = String(key ?? '');
  if (s.length <= 10) return '<redacted>';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}
