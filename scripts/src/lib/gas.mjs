/**
 * Network-fee prechecks for the --send paths.
 *
 * Why this exists: a wallet holding enough USDC but no native coin cannot pay
 * the network fee. Before this check the EVM path failed inside viem's own
 * estimation with a raw RPC error, and the Solana path failed at broadcast,
 * AFTER claimSend had locked the order against any further automated send.
 * Both now stop before signing with one of two codes:
 *
 *   INSUFFICIENT_GAS       the fee coin balance is provably short. Details say
 *                          which network, which coin, what is held, what is
 *                          needed and the shortfall.
 *   GAS_CHECK_UNAVAILABLE  the balance or fee could not be read. This is NOT
 *                          evidence of a shortfall, and NOT evidence of a zero
 *                          fee. The automated send stops; paying by hand from
 *                          a wallet is unaffected.
 *
 * Neither code moves money or touches the order record, so the user can top
 * up the fee coin and re-run, or pick another coin.
 *
 * All amounts are bigint in the coin's smallest unit. No floats.
 */

import { SkillError, redact } from './output.mjs';

/** Fee coin per EVM chain id (all 18 decimals). */
export const EVM_FEE_COIN = Object.freeze({
  1: { symbol: 'ETH', network: 'Ethereum' },
  56: { symbol: 'BNB', network: 'BNB Chain' },
  137: { symbol: 'POL', network: 'Polygon' },
  8453: { symbol: 'ETH', network: 'Base' },
});

export const DEFAULT_GAS_BUFFER_PCT = 20;
const MAX_GAS_BUFFER_PCT = 200;

/**
 * Safety margin on the gas estimate, in percent. An initial engineering value,
 * not a guarantee: ROZO_CHECKOUT_GAS_BUFFER_PCT overrides it (0..200).
 */
export function gasBufferPct(env = process.env) {
  const raw = env?.ROZO_CHECKOUT_GAS_BUFFER_PCT;
  if (raw === undefined || raw === '') return DEFAULT_GAS_BUFFER_PCT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_GAS_BUFFER_PCT) return DEFAULT_GAS_BUFFER_PCT;
  return n;
}

/** Exact decimal string of an atomic bigint amount. */
export function formatAtomic(atomic, decimals) {
  const neg = atomic < 0n;
  const v = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Required fee for an EVM transaction. EIP-1559 when maxFeePerGas is known,
 * else legacy gasPrice. Returns null when neither is known.
 */
export function evmFeeRequirement({ gasEstimate, maxFeePerGas, gasPrice, bufferPct = DEFAULT_GAS_BUFFER_PCT }) {
  const perGas = typeof maxFeePerGas === 'bigint' ? maxFeePerGas : typeof gasPrice === 'bigint' ? gasPrice : null;
  if (typeof gasEstimate !== 'bigint' || perGas === null) return null;
  const gasLimit = (gasEstimate * BigInt(100 + bufferPct) + 99n) / 100n;
  return { gasLimit, perGas, pricing: typeof maxFeePerGas === 'bigint' ? 'eip1559' : 'legacy', fee: gasLimit * perGas };
}

/**
 * Compare a fee-coin balance against what the transaction needs.
 * `required` may be null when the fee itself could not be estimated but the
 * balance is provably zero; a zero balance can never pay a fee.
 */
export function assessFee({ balance, required, decimals, symbol, network }) {
  const ok = required === null ? balance > 0n : balance >= required;
  const details = {
    network,
    feeCoin: symbol,
    balance: formatAtomic(balance, decimals),
    required: required === null ? null : formatAtomic(required, decimals),
    shortfall: required === null || ok ? null : formatAtomic(required - balance, decimals),
  };
  return { ok, details };
}

function insufficient(details, extra) {
  const need = details.required ? `about ${details.required} ${details.feeCoin}` : `some ${details.feeCoin}`;
  return new SkillError(
    'INSUFFICIENT_GAS',
    `This wallet holds ${details.balance} ${details.feeCoin} on ${details.network} but needs ${need} ` +
      `for the network fee${details.shortfall ? ` (short by ${details.shortfall} ${details.feeCoin})` : ''}. ` +
      `Nothing was signed. Add ${details.feeCoin} on ${details.network} to this wallet and re-run, or ` +
      'pay with a different coin.' +
      (extra ? ` ${extra}` : ''),
    details,
  );
}

function unavailable(network, err) {
  return new SkillError(
    'GAS_CHECK_UNAVAILABLE',
    `Could not check the network fee on ${network}: ${redact(err?.shortMessage || err?.message || 'unknown error')}. ` +
      'This is not evidence of a shortfall. Nothing was signed. Retry, pass --rpc <url>, or pay by ' +
      'hand from your wallet.',
    { network },
  );
}

/**
 * EVM: fee for the exact ERC-20 transfer the caller is about to sign.
 * `client` needs getBalance, estimateGas and estimateFeesPerGas (viem public
 * client shape). Throws INSUFFICIENT_GAS / GAS_CHECK_UNAVAILABLE, else
 * returns the assessment details for display.
 */
/**
 * viem's estimateFeesPerGas() defaults to EIP-1559 and throws
 * Eip1559FeesNotSupportedError on a chain without baseFeePerGas. Only that
 * specific error falls back to legacy pricing; any other failure stays a
 * failure (GAS_CHECK_UNAVAILABLE).
 */
export async function estimateFees(client) {
  try {
    return await client.estimateFeesPerGas();
  } catch (err) {
    if (err?.name !== 'Eip1559FeesNotSupportedError') throw err;
    return client.estimateFeesPerGas({ type: 'legacy' });
  }
}

/** OP-stack chains also charge an L1 data fee, checked by the node at submit time. */
export const OP_STACK_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
export const OP_STACK_CHAIN_IDS = new Set([8453]);

export async function evmGasPrecheck({
  client,
  chainId,
  from,
  to,
  data,
  value = 0n,
  bufferPct = gasBufferPct(),
  estimateL1Fee = null,
}) {
  const coin = EVM_FEE_COIN[Number(chainId)] ?? { symbol: 'native coin', network: `chain ${chainId}` };

  let balance;
  try {
    balance = await client.getBalance({ address: from });
  } catch (err) {
    throw unavailable(coin.network, err);
  }

  let gasEstimate;
  let fees;
  try {
    gasEstimate = await client.estimateGas({ account: from, to, data, value });
    fees = await estimateFees(client);
  } catch (err) {
    // Some nodes refuse to estimate for a sender with no native balance. A
    // zero balance is still provably unable to pay any fee.
    if (balance === 0n) {
      throw insufficient(
        assessFee({ balance, required: null, decimals: 18, symbol: coin.symbol, network: coin.network }).details,
      );
    }
    throw unavailable(coin.network, err);
  }

  const req = evmFeeRequirement({
    gasEstimate,
    maxFeePerGas: fees?.maxFeePerGas,
    gasPrice: fees?.gasPrice,
    bufferPct,
  });
  if (!req) throw unavailable(coin.network, new Error('the node returned no fee price'));

  let l1Fee = 0n;
  if (OP_STACK_CHAIN_IDS.has(Number(chainId))) {
    if (typeof estimateL1Fee !== 'function') {
      throw unavailable(coin.network, new Error('no L1 data fee estimator for this OP-stack chain'));
    }
    try {
      // Same buffer as the L2 part: the L1 fee moves with Ethereum's base fee.
      l1Fee = ((await estimateL1Fee()) * BigInt(100 + bufferPct) + 99n) / 100n;
    } catch (err) {
      throw unavailable(coin.network, err);
    }
  }

  const required = req.fee + l1Fee + value;
  const { ok, details } = assessFee({ balance, required, decimals: 18, symbol: coin.symbol, network: coin.network });
  const full = {
    ...details,
    gasLimit: req.gasLimit.toString(),
    pricing: req.pricing,
    bufferPct,
    l1DataFee: OP_STACK_CHAIN_IDS.has(Number(chainId)) ? formatAtomic(l1Fee, 18) : null,
  };
  if (!ok) throw insufficient(full);
  return full;
}

export const LAMPORTS_DECIMALS = 9;

/**
 * Solana: fee for the exact compiled message, plus the System Program rule
 * that the fee payer must end either at exactly zero or at or above the
 * rent-exempt minimum. This path never creates a token account (create-order
 * refuses an address with no token account), so no account rent is added.
 *
 * `connection` needs getBalance, getFeeForMessage and
 * getMinimumBalanceForRentExemption (web3.js Connection shape).
 */
export async function solFeePrecheck({ connection, payer, message }) {
  const network = 'Solana';
  let balance;
  let fee;
  let rentMin;
  try {
    balance = BigInt(await connection.getBalance(payer, 'confirmed'));
    const res = await connection.getFeeForMessage(message, 'confirmed');
    if (res?.value === null || res?.value === undefined) {
      throw new Error('the node returned no fee for this transaction (stale blockhash?)');
    }
    fee = BigInt(res.value);
    rentMin = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  } catch (err) {
    if (balance === 0n) {
      throw insufficient(
        assessFee({ balance, required: null, decimals: LAMPORTS_DECIMALS, symbol: 'SOL', network }).details,
      );
    }
    throw unavailable(network, err);
  }

  const remaining = balance - fee;
  // Ending at exactly zero is allowed; ending between 0 and the rent minimum is not.
  const required = remaining === 0n ? fee : fee + rentMin;
  const { ok, details } = assessFee({ balance, required, decimals: LAMPORTS_DECIMALS, symbol: 'SOL', network });
  const full = { ...details, fee: formatAtomic(fee, LAMPORTS_DECIMALS), rentExemptMinimum: formatAtomic(rentMin, LAMPORTS_DECIMALS) };
  if (!ok) {
    throw insufficient(
      full,
      balance >= fee
        ? 'Solana also requires a wallet to keep a small minimum balance after paying the fee.'
        : null,
    );
  }
  return full;
}
