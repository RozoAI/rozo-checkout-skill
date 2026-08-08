/**
 * Optional balance assistance for the interactive picker.
 *
 * This is DISPLAY-LEVEL ONLY. It annotates the coin list with what a wallet
 * appears to hold so the user can choose sensibly. It must never gate a
 * payment, relax a guard, or change what gets signed:
 *
 *  - Mode A pays from whatever wallet the user actually opens, which we cannot
 *    observe. A tick here is a hint, not a guarantee.
 *  - Every failure degrades to the plain picker. A balance lookup that is slow,
 *    broken or lying must not stop someone paying an invoice.
 *
 * The only place a shortfall is fatal is the non-interactive case where the
 * caller both named a coin and supplied a payer address (see cli.mjs).
 */

import { SkillError } from './output.mjs';

export const INTENT_API_BASE =
  process.env.ROZO_CHECKOUT_INTENT_API || 'https://intentapi.rozo.ai';

export const BALANCE_TIMEOUT_MS = 3000;
export const APP_ID = 'rozoCheckoutCli';

/** Base URL of the settlement chain the quote is denominated in. */
const DEST_CHAIN_ID = 8453;

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Detect which chain family an address belongs to.
 * Order matters: a Stellar address is also valid base32 and could be mistaken
 * for base58, so it is tested before Solana.
 */
export function detectAddressFamily(address) {
  const a = String(address ?? '').trim();
  if (!a) return null;
  if (EVM_RE.test(a)) return 'evm';
  if (STELLAR_RE.test(a)) return 'stellar';
  if (SOLANA_RE.test(a)) return 'solana';
  return null;
}

/** True when a picker row's chain can be vouched for by this address family. */
export function familyCoversChain(family, chainId) {
  const id = String(chainId);
  if (id === 'lightning') return false; // no queryable balance for a BOLT11 payer
  if (id === '900') return family === 'solana';
  if (id === '1500') return family === 'stellar';
  return family === 'evm';
}

/** Build the request for one family. Pure, so the URL shape is testable. */
export function buildBalanceRequest({ family, address, usdRequired }) {
  const usd = Number(usdRequired);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new SkillError('BAD_USD_REQUIRED', 'A positive USD amount is required.');
  }
  const wrap = (payload) => encodeURIComponent(JSON.stringify({ 0: payload }));

  if (family === 'evm') {
    return `${INTENT_API_BASE}/getWalletPaymentOptions?input=${wrap({
      payerAddress: address,
      usdRequired: usd,
      destChainId: DEST_CHAIN_ID,
      appId: APP_ID,
    })}`;
  }
  if (family === 'solana') {
    return `${INTENT_API_BASE}/getSolanaPaymentOptions?input=${wrap({
      pubKey: address,
      usdRequired: usd,
      appId: APP_ID,
    })}`;
  }
  if (family === 'stellar') {
    return `${INTENT_API_BASE}/getStellarPaymentOptions?input=${wrap({
      stellarAddress: address,
      usdRequired: usd,
      appId: APP_ID,
    })}`;
  }
  throw new SkillError('BAD_ADDRESS_FAMILY', `No balance endpoint for family "${family}".`);
}

/**
 * Normalize the backend's payment options into the few fields the picker
 * needs. Tolerant by design: an unexpected shape yields no options rather
 * than an exception, because this whole feature is optional.
 */
export function parsePaymentOptions(json) {
  const data = Array.isArray(json) ? json[0]?.result?.data : json?.result?.data ?? json?.data;
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const o of data) {
    const token = o?.balance?.token ?? o?.required?.token;
    const chainId = token?.chainId;
    const symbol = token?.symbol;
    if (chainId === undefined || !symbol) continue;
    const balanceUsd = Number(o?.balance?.usd);
    const requiredUsd = Number(o?.required?.usd);
    out.push({
      chainId: String(chainId),
      tokenSymbol: String(symbol).toUpperCase(),
      balanceUsd: Number.isFinite(balanceUsd) ? balanceUsd : null,
      requiredUsd: Number.isFinite(requiredUsd) ? requiredUsd : null,
      // The backend's own verdict wins when present; otherwise compare.
      affordable:
        o?.disabledReason === undefined || o?.disabledReason === null
          ? true
          : false,
      disabledReason: o?.disabledReason ?? null,
    });
  }
  return out;
}

/**
 * Annotate picker rows with balance marks, and sort affordable ones first
 * while keeping the original order within each group.
 *
 * @returns {Array} picker options each carrying { mark, balanceUsd }
 *   mark: 'affordable' | 'insufficient' | 'unchecked'
 */
export function markPickerOptions(pickerOptions, { family = null, options = [] } = {}) {
  const index = new Map();
  for (const o of options) index.set(`${o.chainId}:${o.tokenSymbol}`, o);

  const marked = pickerOptions.map((row) => {
    if (!family || !familyCoversChain(family, row.chainId)) {
      return { ...row, mark: 'unchecked', balanceUsd: null, note: null };
    }
    const hit = index.get(`${row.chainId}:${row.tokenSymbol}`);
    if (!hit) {
      return { ...row, mark: 'insufficient', balanceUsd: 0, note: 'no balance found' };
    }
    return {
      ...row,
      mark: hit.affordable ? 'affordable' : 'insufficient',
      balanceUsd: hit.balanceUsd,
      note: hit.disabledReason,
    };
  });

  const rank = { affordable: 0, unchecked: 1, insufficient: 2 };
  return marked
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank[a.row.mark] - rank[b.row.mark] || a.i - b.i)
    .map(({ row }) => row);
}

/**
 * Fetch balance options for an address. Never throws: a failure returns
 * { ok: false, reason } so the caller can show the plain picker.
 */
export async function fetchWalletOptions({ address, usdRequired, timeoutMs = BALANCE_TIMEOUT_MS }) {
  const family = detectAddressFamily(address);
  if (!family) return { ok: false, family: null, options: [], reason: 'unrecognised address format' };

  let url;
  try {
    url = buildBalanceRequest({ family, address, usdRequired });
  } catch (err) {
    return { ok: false, family, options: [], reason: err.message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, family, options: [], reason: `balance service returned HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, family, options: parsePaymentOptions(json), reason: null };
  } catch (err) {
    const reason =
      err?.name === 'AbortError' ? 'balance check timed out' : 'balance service unreachable';
    return { ok: false, family, options: [], reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Can this address demonstrably not afford the chosen coin?
 * Returns true ONLY on positive evidence of a shortfall — an unchecked or
 * unavailable balance is never treated as insufficient.
 */
export function isProvablyShort({ chainId, tokenSymbol }, { ok, family, options }) {
  if (!ok || !family) return false;
  if (!familyCoversChain(family, chainId)) return false;
  const hit = options.find(
    (o) => o.chainId === String(chainId) && o.tokenSymbol === String(tokenSymbol).toUpperCase(),
  );
  if (!hit) return false;
  return hit.affordable === false;
}
