/**
 * Native coin helpers that need no signing library: payer-facing warnings and
 * the optional native balance check behind the coin picker.
 *
 * The balance check is DISPLAY-LEVEL ONLY, exactly like wallet-check.mjs: it
 * annotates the coin list and the order summary, never gates a payment on its
 * own, never relaxes a guard, and every failure degrades to "not checked". The
 * Rozo balance service does not report native coins, so this reads the chain
 * directly (eth_getBalance / getBalance) over public JSON-RPC.
 *
 * A native payment spends the coin that also pays the network fee, so a
 * wallet holding exactly the order amount cannot send it. Every verdict here
 * therefore compares against amount + a gas headroom, not the amount alone.
 */

import { NATIVE_COINS, chainName, chainFamily } from './amounts.mjs';
import { formatAtomic } from './gas.mjs';
import { rpcFor } from './rpc.mjs';

export const NATIVE_BALANCE_TIMEOUT_MS = 3000;

/**
 * Gas allowed for one native value transfer when sizing the headroom. A plain
 * transfer to a wallet costs 21,000; a deposit address that is a contract
 * costs more, so the headroom is sized generously. Display only.
 */
export const EVM_HEADROOM_GAS = 100_000n;

/**
 * Solana headroom in lamports: the transaction fee plus the rent-exempt
 * minimum a wallet must keep unless it is emptied completely (0.001 SOL).
 */
export const SOL_HEADROOM_LAMPORTS = 1_000_000n;

/** Warnings shown with every native deposit block, in addition to the usual ones. */
export function nativeDepositWarnings({ tokenSymbol, chainId }) {
  const coin = String(tokenSymbol || '').toUpperCase();
  return [
    `This is an exact-out ${coin} order: send exactly the amount shown, in one transfer. The ` +
      'coin price is locked only until the time shown; after that, do not send, start a new order.',
    `The ${coin} amount includes an FX spread on top of the service fee.`,
    `Your wallet also needs some ${coin} on ${chainName(chainId)} for the network fee, on top of ` +
      'the amount shown.',
    'Paying from an exchange: make sure the amount that ARRIVES is exactly the amount shown. ' +
      'Exchanges often subtract their withdrawal fee, and a short payment may need manual review.',
  ];
}

/** The native coins of one address family, optionally filtered by `isOffered`. */
export function nativeCoinsForFamily(family, isOffered = null) {
  return Object.values(NATIVE_COINS).filter(
    (c) =>
      chainFamily(c.chainId) === family &&
      (typeof isOffered !== 'function' || isOffered(c.chainId, c.symbol)),
  );
}

async function rpcCall(fetchImpl, url, method, params, signal) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(String(json.error?.message ?? 'rpc error'));
  return json?.result;
}

function hexToBigInt(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error('not a hex quantity');
  }
  return BigInt(value);
}

/**
 * Read one native balance plus the gas headroom for one send. Never throws:
 * `{ ok: false, reason }` on any failure, so the caller shows "not checked".
 */
export async function fetchNativeBalance({
  chainId,
  address,
  fetchImpl = globalThis.fetch,
  timeoutMs = NATIVE_BALANCE_TIMEOUT_MS,
  env = process.env,
}) {
  // Each chain has exactly one native coin.
  const coin = Object.values(NATIVE_COINS).find((c) => c.chainId === String(chainId));
  if (!coin) return { ok: false, chainId: String(chainId), reason: 'not a native coin chain' };
  const base = { chainId: coin.chainId, tokenSymbol: coin.symbol, decimals: coin.decimals };
  let url;
  try {
    url = rpcFor(coin.chainId, null, env);
  } catch (err) {
    return { ...base, ok: false, reason: err.message };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (chainFamily(coin.chainId) === 'solana') {
      const r = await rpcCall(fetchImpl, url, 'getBalance', [address, { commitment: 'confirmed' }], controller.signal);
      const lamports = r?.value;
      if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('bad balance');
      return { ...base, ok: true, balanceAtomic: BigInt(lamports), headroomAtomic: SOL_HEADROOM_LAMPORTS };
    }
    const [bal, gasPrice] = await Promise.all([
      rpcCall(fetchImpl, url, 'eth_getBalance', [address, 'latest'], controller.signal),
      rpcCall(fetchImpl, url, 'eth_gasPrice', [], controller.signal),
    ]);
    const balanceAtomic = hexToBigInt(bal);
    // 20% over the node's current gas price, for EVM_HEADROOM_GAS gas.
    const headroomAtomic = (hexToBigInt(gasPrice) * EVM_HEADROOM_GAS * 120n) / 100n;
    return { ...base, ok: true, balanceAtomic, headroomAtomic };
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: err?.name === 'AbortError' ? 'balance check timed out' : 'balance check unavailable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Balances for every native coin of the address's family (in parallel). */
export async function fetchNativeBalances({ address, family, isOffered = null, ...rest }) {
  const coins = nativeCoinsForFamily(family, isOffered);
  return Promise.all(coins.map((c) => fetchNativeBalance({ chainId: c.chainId, address, ...rest })));
}

/**
 * Verdict for one native balance.
 *
 * Without an amount (the picker runs before the order prices the coin) the
 * only provable statement is "cannot pay anything": a balance at or under the
 * gas headroom. Otherwise the row is 'held', shown with its coin balance.
 *
 * With an amount:
 *   insufficient  balance < amount                (provable)
 *   tight         amount <= balance < amount + headroom (likely short of gas)
 *   affordable    balance >= amount + headroom
 *
 * @returns {{mark:'affordable'|'tight'|'insufficient'|'held', provable:boolean}}
 */
export function assessNative({ balanceAtomic, headroomAtomic, amountAtomic = null }) {
  if (amountAtomic === null || amountAtomic === undefined) {
    if (balanceAtomic <= headroomAtomic) return { mark: 'insufficient', provable: balanceAtomic === 0n };
    return { mark: 'held', provable: false };
  }
  if (balanceAtomic < amountAtomic) return { mark: 'insufficient', provable: true };
  if (balanceAtomic < amountAtomic + headroomAtomic) return { mark: 'tight', provable: false };
  return { mark: 'affordable', provable: false };
}

/** Human line for a balance result, e.g. "0.0123 ETH held". */
export function formatNativeHeld(result) {
  if (!result?.ok) return null;
  return `${formatAtomic(result.balanceAtomic, result.decimals)} ${result.tokenSymbol}`;
}
