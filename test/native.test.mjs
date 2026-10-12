/**
 * Native coins (ETH on Ethereum / Base / Arbitrum, BNB, POL, SOL) and the
 * Arbitrum stablecoins.
 *
 * A native order is exact-out like Lightning: the coin amount is fixed at
 * create, its price is locked only until quoteExpiresAt, and it is paid with a
 * plain value transfer. These tests pin the decimals, the offer gate, the price
 * lock on every path that decides "can this still be paid", the transaction
 * that gets signed, and the guards around it. No network: every RPC and HTTP
 * call is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Keypair, PublicKey, SystemProgram, SystemInstruction } from '@solana/web3.js';

import {
  decimalsFor,
  toAtomic,
  comparePayment,
  isNativeSource,
  isNativeTokenAddress,
  nativeOfferFor,
  nativeMinUsdFor,
  chainFamily,
  chainName,
  NATIVE_MAX_USD,
} from '../scripts/src/lib/amounts.mjs';
import { checkExpiry, priceLockFor, settlementWatchSeconds, MINUTE } from '../scripts/src/lib/expiry.mjs';
import { solFeePrecheck, evmGasPrecheck } from '../scripts/src/lib/gas.mjs';
import { assessNative, fetchNativeBalance, nativeDepositWarnings } from '../scripts/src/lib/native.mjs';
import {
  prepareEvmNativeSend,
  assertPreparedNativeRequest,
  prepareSolNativeSend,
} from '../scripts/src/lib/native-send.mjs';
import { markPickerOptions } from '../scripts/src/lib/wallet-check.mjs';
import { PICKER_OPTIONS } from '../scripts/src/lib/cli-args.mjs';
import { classifyStatus } from '../scripts/src/lib/guards.mjs';
import { capture } from '../scripts/src/lib/output.mjs';
import { readState, statePath, writeAtomic } from '../scripts/src/lib/state.mjs';
import { preflight, sendPriceLock, finalPayabilityCheck } from '../scripts/src/lib/presend.mjs';
import { sendWindowFor } from '../scripts/src/status.mjs';
import { rpcFor } from '../scripts/src/lib/rpc.mjs';
import { run as runCreateOrder } from '../scripts/src/create-order.mjs';
import { run as runQuote } from '../scripts/src/quote.mjs';
import { run as runCreateBitrefill } from '../scripts/src/create-bitrefill-order.mjs';

process.env.ROZO_CHECKOUT_ANON_ID = 'off';

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const FROM = '0x1234567890abcdef1234567890ABCDEF12345678';
const DEPOSIT = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const BLACKLISTED_EVM = '0x8FE7155119d2975780c9e19B07dD98393965Bc2a';
const inMin = (m) => new Date(Date.now() + m * MINUTE).toISOString();

async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected ${code}`);
}

// ---------------------------------------------------------------------------
// decimals and amounts
// ---------------------------------------------------------------------------

test('decimals: ETH/BNB/POL are 18 (wei), SOL is 9 (lamports), Arbitrum USDC/USDT are 6', () => {
  for (const [cid, sym] of [['1', 'ETH'], ['8453', 'ETH'], ['42161', 'ETH'], ['56', 'BNB'], ['137', 'POL']]) {
    assert.equal(decimalsFor(cid, sym), 18, `${sym}@${cid}`);
  }
  assert.equal(decimalsFor('900', 'SOL'), 9);
  assert.equal(decimalsFor('900', 'sol'), 9);
  assert.equal(decimalsFor('42161', 'USDC'), 6);
  assert.equal(decimalsFor('42161', 'USDT'), 6);
  // A native coin on the wrong chain has no decimals, and is never guessed.
  assert.throws(() => decimalsFor('900', 'ETH'), (e) => e.code === 'UNKNOWN_DECIMALS');
  assert.throws(() => decimalsFor('42161', 'BNB'), (e) => e.code === 'UNKNOWN_DECIMALS');
});

test('native amounts convert exactly and refuse precision the coin does not have', () => {
  assert.equal(toAtomic('0.00373452', 18), 3_734_520_000_000_000n);
  assert.equal(toAtomic('1', 18), ETH);
  assert.equal(toAtomic('0.000000000000000001', 18), 1n);
  assert.equal(toAtomic('0.0812', 9), 81_200_000n);
  assert.equal(toAtomic('1', 9), 1_000_000_000n);
  // 10 decimals is more than SOL can represent: refused, never truncated.
  assert.throws(() => toAtomic('0.0000000001', 9), (e) => e.code === 'AMOUNT_PRECISION');
  assert.throws(() => toAtomic('1e-5', 18), (e) => e.code === 'BAD_AMOUNT');
});

test('comparePayment works on 18 and 9 decimals: exact, underpaid, overpaid', () => {
  const eth = { chainId: '8453', tokenSymbol: 'ETH', amount: '0.00373452' };
  assert.equal(comparePayment({ ...eth, amountReceived: '0.00373452' }).state, 'exact');
  assert.equal(comparePayment({ ...eth, amountReceived: '0.003734520000000000' }).state, 'exact');
  const under = comparePayment({ ...eth, amountReceived: '0.003734519999999999' });
  assert.equal(under.state, 'underpaid');
  assert.equal(under.deltaAtomic, '-1');
  assert.equal(comparePayment({ ...eth, amountReceived: '0.004' }).state, 'overpaid');

  const sol = { chainId: '900', tokenSymbol: 'SOL', amount: '0.0812' };
  assert.equal(comparePayment({ ...sol, amountReceived: '0.0812' }).state, 'exact');
  const solUnder = comparePayment({ ...sol, amountReceived: '0.081199999' });
  assert.equal(solUnder.state, 'underpaid');
  assert.equal(solUnder.deltaAtomic, '-1');
  assert.equal(comparePayment({ ...sol, amountReceived: '0' }).state, 'none');

  const usdtArb = { chainId: '42161', tokenSymbol: 'USDT', amount: '10.100000' };
  assert.equal(comparePayment({ ...usdtArb, amountReceived: '10.1' }).state, 'exact');
});

test('native coin identity: chain-specific, and the token-address sentinels', () => {
  assert.ok(isNativeSource('1', 'ETH'));
  assert.ok(isNativeSource('42161', 'eth'));
  assert.ok(isNativeSource('137', 'POL'));
  assert.ok(!isNativeSource('137', 'MATIC'));
  assert.ok(!isNativeSource('1', 'USDC'));
  assert.ok(!isNativeSource('lightning', 'BTC'));
  assert.equal(chainFamily('42161'), 'evm');
  assert.equal(chainName('42161'), 'Arbitrum');

  for (const ok of [null, undefined, '', ZERO, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', 'native', 'NATIVE', '11111111111111111111111111111111']) {
    assert.ok(isNativeTokenAddress(ok), String(ok));
  }
  for (const bad of ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']) {
    assert.ok(!isNativeTokenAddress(bad), bad);
  }
});

// ---------------------------------------------------------------------------
// offer gate: supportedSources + USD bounds
// ---------------------------------------------------------------------------

const ALL_SOURCES = {
  1: ['USDC', 'USDT', 'ETH'],
  56: ['USDC', 'USDT', 'BNB'],
  137: ['USDC', 'USDT', 'POL'],
  900: ['USDC', 'USDT', 'SOL'],
  1500: ['USDC'],
  8453: ['USDC', 'ETH'],
  42161: ['USDC', 'USDT', 'ETH'],
};

test('a native coin is offered only when supportedSources lists it for this invoice', () => {
  const offer = (chainId, tokenSymbol, supportedSources, callerPaysUsd = '10') =>
    nativeOfferFor({ chainId, tokenSymbol, supportedSources, callerPaysUsd });
  assert.equal(offer('8453', 'ETH', ALL_SOURCES).ok, true);
  assert.equal(offer('137', 'POL', ALL_SOURCES).ok, true);
  assert.equal(offer('8453', 'ETH', { 8453: ['USDC'] }).code, 'NATIVE_NOT_OFFERED');
  // No list, or a malformed one, is never read as "everything is offered".
  assert.equal(offer('8453', 'ETH', null).code, 'NATIVE_NOT_OFFERED');
  assert.equal(offer('8453', 'ETH', undefined).code, 'NATIVE_NOT_OFFERED');
  assert.equal(offer('8453', 'ETH', { 8453: 'ETH' }).code, 'NATIVE_NOT_OFFERED');
  assert.equal(offer('8453', 'USDC', ALL_SOURCES).code, 'NOT_NATIVE');
});

test('native USD bounds: $2,000 cap, $1 minimum for native ETH on Ethereum, quote minimum wins', () => {
  const offer = (chainId, tokenSymbol, callerPaysUsd, nativeMinUsd) =>
    nativeOfferFor({ chainId, tokenSymbol, supportedSources: ALL_SOURCES, nativeMinUsd, callerPaysUsd });
  assert.equal(NATIVE_MAX_USD, 2000);
  assert.equal(offer('8453', 'ETH', '2000').ok, true);
  assert.equal(offer('8453', 'ETH', '2000.01').code, 'NATIVE_AMOUNT_TOO_HIGH');
  assert.equal(offer('1', 'ETH', '0.99').code, 'NATIVE_AMOUNT_TOO_LOW');
  assert.equal(offer('1', 'ETH', '1').ok, true);
  assert.equal(offer('8453', 'ETH', '0.5').ok, true);
  // The router's own per-coin minimum overrides the fallback.
  assert.equal(offer('900', 'SOL', '0.5', { 900: { SOL: 1 } }).code, 'NATIVE_AMOUNT_TOO_LOW');
  assert.equal(nativeMinUsdFor('900', 'SOL', { 900: { SOL: 1 } }), 1);
  assert.equal(nativeMinUsdFor('1', 'ETH', null), 1);
  assert.equal(nativeMinUsdFor('8453', 'ETH', null), null);
  // An unknown amount defers to the backend instead of guessing.
  assert.equal(offer('1', 'ETH', null).ok, true);
});

// ---------------------------------------------------------------------------
// price lock (quoteExpiresAt)
// ---------------------------------------------------------------------------

test('checkExpiry: a native order is bounded by its price lock, and refuses without one', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  const base = {
    now,
    chainId: '8453',
    intentExpiresAt: now + 12 * 60 * MINUTE, // the order stays open for hours
    coinbaseExpiry: now + 24 * 60 * MINUTE,
  };
  const ok = checkExpiry({ ...base, quoteExpiresAt: now + 60 * MINUTE });
  assert.equal(ok.ok, true);
  assert.equal(ok.effectiveDeadlineMs, now + 60 * MINUTE, 'the lock, not the order, is the deadline');
  assert.equal(ok.deadlines.quoteMs, now + 60 * MINUTE);

  const missing = checkExpiry({ ...base, quoteExpiresAt: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'EXPIRY_UNPARSABLE');
  assert.match(missing.reason, /quoteExpiresAt/);

  const expired = checkExpiry({ ...base, quoteExpiresAt: now - 1 });
  assert.equal(expired.code, 'QUOTE_EXPIRED');

  const tight = checkExpiry({ ...base, quoteExpiresAt: now + 5 * MINUTE });
  assert.equal(tight.code, 'QUOTE_EXPIRY_MARGIN');

  // Not native: undefined leaves the old behaviour untouched.
  const stable = checkExpiry({ ...base });
  assert.equal(stable.ok, true);
  assert.equal(stable.effectiveDeadlineMs, base.intentExpiresAt);
  assert.equal(stable.deadlines.quoteMs, null);

  // When the Coinbase link ends first, the old code still names it.
  const linkFirst = checkExpiry({ ...base, coinbaseExpiry: now - 1, quoteExpiresAt: now + 60 * MINUTE });
  assert.equal(linkFirst.code, 'EXPIRED');
});

test('priceLockFor: undefined for non-native, earliest known lock, null when none', () => {
  assert.equal(priceLockFor({ native: false, payment: { quoteExpiresAt: inMin(5) } }), undefined);
  assert.equal(priceLockFor({ native: true, payment: {} }), null);
  const early = '2026-10-12T01:00:00.000Z';
  const late = '2026-10-12T02:00:00.000Z';
  assert.equal(priceLockFor({ native: true, payment: { quoteExpiresAt: late }, others: [early] }), early);
  assert.equal(priceLockFor({ native: true, payment: { source: { quoteExpiresAt: early } }, others: [late, null, 'junk'] }), early);
});

test('sendPriceLock: the lock a human confirmed can only shorten the send window', () => {
  const live = inMin(50);
  const confirmed = inMin(20);
  const payment = { quoteExpiresAt: live, source: { chainId: '42161', tokenSymbol: 'ETH' } };
  assert.equal(sendPriceLock(payment, { confirmation: { quoteExpiresAt: confirmed } }), new Date(confirmed).toISOString());
  assert.equal(sendPriceLock(payment, {}), new Date(live).toISOString());
  assert.equal(sendPriceLock({ source: { chainId: '42161', tokenSymbol: 'ETH' } }, {}), null);
  assert.equal(sendPriceLock({ quoteExpiresAt: live, source: { chainId: '42161', tokenSymbol: 'USDC' } }, {}), undefined);
});

test('settlement watch follows the price lock for a native order (capped at 60 minutes)', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  const deposit = { quoteExpiresAt: new Date(now + 30 * MINUTE).toISOString() };
  assert.equal(settlementWatchSeconds({ timeout: 900 }, deposit, now), 30 * 60);
  const long = { quoteExpiresAt: new Date(now + 3 * 60 * MINUTE).toISOString() };
  assert.equal(settlementWatchSeconds({ timeout: 900 }, long, now), 60 * 60);
  assert.equal(settlementWatchSeconds({ timeout: 120, timeoutExplicit: true }, deposit, now), 120);
  assert.equal(settlementWatchSeconds({ timeout: 900 }, {}, now), 900);
});

test('status send window: a native order past its price lock is not payable', () => {
  const status = {
    coinbase: { protocolVersion: 'v1', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(600), settled: false },
  };
  const payment = { expiresAt: inMin(600) };
  const open = sendWindowFor({ provider: 'coinbase', chainId: '8453', payment, status, quoteExpiresAt: inMin(45) });
  assert.equal(open.ok, true);
  const closed = sendWindowFor({ provider: 'coinbase', chainId: '8453', payment, status, quoteExpiresAt: inMin(-1) });
  assert.equal(closed.ok, false);
  assert.equal(closed.code, 'QUOTE_EXPIRED');
  const unknown = sendWindowFor({ provider: 'coinbase', chainId: '8453', payment, status, quoteExpiresAt: null });
  assert.equal(unknown.code, 'EXPIRY_UNPARSABLE');
});

test('deposit warnings for a native order name the exact-out rule, the spread and the gas', () => {
  const w = nativeDepositWarnings({ tokenSymbol: 'pol', chainId: '137' }).join(' ');
  assert.match(w, /exact-out POL order/);
  assert.match(w, /FX spread/);
  assert.match(w, /POL on Polygon for the network fee/);
  assert.match(w, /exchange/i);
  assert.doesNotMatch(w, /beta/i, 'POL is not beta');
});

// ---------------------------------------------------------------------------
// gas and balance checks
// ---------------------------------------------------------------------------

function evmClient({ balance = ETH, gas = 21_000n, fees = { maxFeePerGas: 30n * GWEI }, failBalance } = {}) {
  const calls = { estimateGas: [] };
  return {
    calls,
    async getBalance() {
      if (failBalance) throw new Error('rpc down');
      return balance;
    },
    async estimateGas(args) {
      calls.estimateGas.push(args);
      return gas;
    },
    async estimateFeesPerGas() {
      return fees;
    },
  };
}

test('EVM gas precheck counts the native payment against the same balance', async () => {
  const value = ETH / 100n; // 0.01
  // Fee = ceil(21000 * 1.2) * 30 gwei = 25200 * 30 gwei = 0.000756 ETH.
  const ok = await evmGasPrecheck({ client: evmClient({ balance: ETH / 10n }), chainId: 1, from: FROM, to: DEPOSIT, value });
  assert.equal(ok.payment, '0.01');
  const err = await rejectsWith(
    evmGasPrecheck({ client: evmClient({ balance: value }), chainId: 1, from: FROM, to: DEPOSIT, value }),
    'INSUFFICIENT_GAS',
  );
  assert.match(err.message, /payment of 0\.01 ETH plus the network fee/);
});

test('Solana fee precheck counts the lamports sent and keeps the rent rule', async () => {
  const payer = Keypair.generate().publicKey;
  const conn = (balance) => ({
    async getBalance() { return balance; },
    async getFeeForMessage() { return { value: 5000 }; },
    async getMinimumBalanceForRentExemption() { return 890_880; },
  });
  // Exactly fee + value empties the wallet: allowed.
  const exact = await solFeePrecheck({ connection: conn(1_005_000), payer, message: {}, value: 1_000_000n });
  assert.equal(exact.payment, '0.001');
  // Leaving 1 lamport is below rent: refused.
  await rejectsWith(solFeePrecheck({ connection: conn(1_005_001), payer, message: {}, value: 1_000_000n }), 'INSUFFICIENT_GAS');
  // Fee + value + rent: fine.
  await solFeePrecheck({ connection: conn(1_005_000 + 890_880), payer, message: {}, value: 1_000_000n });
  // An SPL send (value 0) is unchanged.
  await solFeePrecheck({ connection: conn(5000), payer, message: {} });
});

test('assessNative: provable only below the amount; amount + gas headroom is the real bar', () => {
  const amount = 10n;
  const headroom = 3n;
  assert.deepEqual(assessNative({ balanceAtomic: 9n, headroomAtomic: headroom, amountAtomic: amount }), { mark: 'insufficient', provable: true });
  assert.deepEqual(assessNative({ balanceAtomic: 11n, headroomAtomic: headroom, amountAtomic: amount }), { mark: 'tight', provable: false });
  assert.deepEqual(assessNative({ balanceAtomic: 13n, headroomAtomic: headroom, amountAtomic: amount }), { mark: 'affordable', provable: false });
  // Before the order prices the coin: only "cannot even pay gas" is a verdict.
  assert.deepEqual(assessNative({ balanceAtomic: 0n, headroomAtomic: headroom }), { mark: 'insufficient', provable: true });
  assert.deepEqual(assessNative({ balanceAtomic: 2n, headroomAtomic: headroom }), { mark: 'insufficient', provable: false });
  assert.deepEqual(assessNative({ balanceAtomic: 100n, headroomAtomic: headroom }), { mark: 'held', provable: false });
});

test('fetchNativeBalance reads eth_getBalance / getBalance over JSON-RPC and never throws', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, method: body.method, params: body.params });
    const result =
      body.method === 'eth_getBalance' ? '0xde0b6b3a7640000' // 1 ETH
        : body.method === 'eth_gasPrice' ? '0x3b9aca00' // 1 gwei
          : body.method === 'getBalance' ? { context: { slot: 1 }, value: 81_200_000 }
            : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  };
  const eth = await fetchNativeBalance({ chainId: '42161', address: FROM, fetchImpl, env: {} });
  assert.equal(eth.ok, true);
  assert.equal(eth.tokenSymbol, 'ETH');
  assert.equal(eth.balanceAtomic, ETH);
  assert.equal(eth.headroomAtomic, (GWEI * 100_000n * 120n) / 100n);
  assert.ok(seen.every((c) => c.url === 'https://arb1.arbitrum.io/rpc'));

  const sol = await fetchNativeBalance({ chainId: '900', address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', fetchImpl, env: {} });
  assert.equal(sol.ok, true);
  assert.equal(sol.tokenSymbol, 'SOL');
  assert.equal(sol.decimals, 9);
  assert.equal(sol.balanceAtomic, 81_200_000n);

  // An override env var is honoured.
  seen.length = 0;
  await fetchNativeBalance({ chainId: '137', address: FROM, fetchImpl, env: { ROZO_CHECKOUT_RPC_137: 'https://polygon.example' } });
  assert.ok(seen.every((c) => c.url === 'https://polygon.example'));

  const broken = await fetchNativeBalance({ chainId: '1', address: FROM, fetchImpl: async () => { throw new Error('down'); }, env: {} });
  assert.equal(broken.ok, false);
  const badHex = await fetchNativeBalance({
    chainId: '1', address: FROM, env: {},
    fetchImpl: async () => new Response(JSON.stringify({ result: 'lots' }), { status: 200 }),
  });
  assert.equal(badHex.ok, false);
  const notNative = await fetchNativeBalance({ chainId: '1500', address: FROM, fetchImpl, env: {} });
  assert.equal(notNative.ok, false);
});

test('rpcFor knows Arbitrum and Solana, and honours overrides', () => {
  assert.equal(rpcFor('42161', null, {}), 'https://arb1.arbitrum.io/rpc');
  assert.equal(rpcFor('900', null, {}), 'https://api.mainnet-beta.solana.com');
  assert.equal(rpcFor('42161', 'https://x.example', {}), 'https://x.example');
  assert.equal(rpcFor('42161', null, { ROZO_CHECKOUT_RPC_42161: 'https://y.example' }), 'https://y.example');
  assert.throws(() => rpcFor('1500', null, {}), (e) => e.code === 'NO_RPC');
});

test('picker marks native rows from native balances, never from the stablecoin answer', () => {
  const native = [
    { ok: true, chainId: '8453', tokenSymbol: 'ETH', decimals: 18, balanceAtomic: ETH / 2n, headroomAtomic: 1000n },
    { ok: true, chainId: '1', tokenSymbol: 'ETH', decimals: 18, balanceAtomic: 0n, headroomAtomic: 1000n },
    { ok: false, chainId: '42161', reason: 'balance check timed out' },
  ];
  const marked = markPickerOptions(PICKER_OPTIONS, { family: 'evm', options: [], native, ok: true });
  const row = (preset) => marked.find((o) => o.preset === preset);
  assert.equal(row('eth-base').mark, 'held');
  assert.equal(row('eth-base').held, '0.5 ETH');
  assert.equal(row('eth-ethereum').mark, 'insufficient');
  assert.equal(row('eth-arbitrum').mark, 'unchecked');
  assert.equal(row('sol-solana').mark, 'unchecked', 'an EVM address says nothing about Solana');
  assert.equal(marked.length, PICKER_OPTIONS.length, 'no row may be dropped');
  // A failed stablecoin lookup leaves stablecoin rows unchecked, not "insufficient".
  const failed = markPickerOptions(PICKER_OPTIONS, { family: 'evm', options: [], native, ok: false });
  assert.equal(failed.find((o) => o.preset === 'usdc-arbitrum').mark, 'unchecked');
  assert.equal(failed.find((o) => o.preset === 'eth-base').mark, 'held');
});

// ---------------------------------------------------------------------------
// native send construction (stubbed RPC)
// ---------------------------------------------------------------------------

test('EVM native send: exact value to the deposit address, no calldata, gas checked with the value', async () => {
  const amount = toAtomic('0.00373452', 18);
  const client = evmClient({ balance: ETH });
  const r = await prepareEvmNativeSend({
    client, chainId: 42161, from: FROM, to: DEPOSIT, amountAtomic: amount, tokenAddress: ZERO, tokenSymbol: 'ETH',
  });
  assert.deepEqual(r.request, { to: DEPOSIT, value: amount });
  assert.equal(r.networkFee.feeCoin, 'ETH');
  assert.equal(r.networkFee.network, 'Arbitrum');
  assert.equal(client.calls.estimateGas.length, 1);
  assert.equal(client.calls.estimateGas[0].value, amount);
  assert.equal(client.calls.estimateGas[0].to, DEPOSIT);
  assert.equal(client.calls.estimateGas[0].data, undefined);
});

test('EVM native send: the guards', async () => {
  const amount = ETH / 100n;
  const args = { chainId: 1, from: FROM, to: DEPOSIT, amountAtomic: amount, tokenAddress: ZERO, tokenSymbol: 'ETH' };
  await rejectsWith(prepareEvmNativeSend({ ...args, client: evmClient({ balance: amount - 1n }) }), 'INSUFFICIENT_BALANCE');
  // Holds the amount but not the amount plus the fee.
  await rejectsWith(prepareEvmNativeSend({ ...args, client: evmClient({ balance: amount }) }), 'INSUFFICIENT_GAS');
  await rejectsWith(prepareEvmNativeSend({ ...args, client: evmClient({ failBalance: true }) }), 'GAS_CHECK_UNAVAILABLE');
  await rejectsWith(
    prepareEvmNativeSend({ ...args, client: evmClient(), tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }),
    'NATIVE_TOKEN_ADDRESS_UNEXPECTED',
  );
  await rejectsWith(prepareEvmNativeSend({ ...args, client: evmClient(), to: '0x1234' }), 'BAD_DEPOSIT_ADDRESS');
  await rejectsWith(prepareEvmNativeSend({ ...args, client: evmClient(), amountAtomic: 0n }), 'DEPOSIT_INCOMPLETE');
  // Base is OP-stack: no L1 fee estimator means no send, exactly as for ERC-20.
  await rejectsWith(prepareEvmNativeSend({ ...args, chainId: 8453, client: evmClient() }), 'GAS_CHECK_UNAVAILABLE');
  const base = await prepareEvmNativeSend({ ...args, chainId: 8453, client: evmClient(), estimateL1Fee: async () => 1000n });
  assert.equal(base.networkFee.l1DataFee, '0.0000000000000012');
});

test('EVM native send: the prepared request must still be exactly the confirmed transfer', () => {
  const value = 123n;
  assert.ok(assertPreparedNativeRequest({ to: DEPOSIT.toUpperCase().replace('0X', '0x'), value, nonce: 1 }, { to: DEPOSIT, value }));
  assert.ok(assertPreparedNativeRequest({ to: DEPOSIT, value, data: '0x' }, { to: DEPOSIT, value }));
  assert.throws(() => assertPreparedNativeRequest({ to: FROM, value }, { to: DEPOSIT, value }), (e) => e.code === 'PREPARED_TX_MISMATCH');
  assert.throws(() => assertPreparedNativeRequest({ to: DEPOSIT, value: 124n }, { to: DEPOSIT, value }), (e) => e.code === 'PREPARED_TX_MISMATCH');
  assert.throws(() => assertPreparedNativeRequest({ to: DEPOSIT, value, data: '0xa9059cbb' }, { to: DEPOSIT, value }), (e) => e.code === 'PREPARED_TX_MISMATCH');
});

function solConnection({ balance = 1_000_000_000, recipientInfo = null, rent = 890_880, fee = 5000 } = {}) {
  const blockhash = Keypair.generate().publicKey.toBase58();
  return {
    blockhash,
    async getAccountInfo() { return recipientInfo; },
    async getMinimumBalanceForRentExemption() { return rent; },
    async getBalance() { return balance; },
    async getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 100 }; },
    async getFeeForMessage() { return { value: fee }; },
  };
}

test('Solana native send: one System Program transfer of the exact lamports (plus memo when given)', async () => {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const amount = toAtomic('0.0812', 9);
  const conn = solConnection({ recipientInfo: { owner: SystemProgram.programId, executable: false, lamports: 1 } });
  const r = await prepareSolNativeSend({
    connection: conn, payer, recipientAddress: recipient.toBase58(), amountAtomic: amount, tokenAddress: 'native',
  });
  assert.equal(r.tx.instructions.length, 1);
  const ix = r.tx.instructions[0];
  assert.ok(ix.programId.equals(SystemProgram.programId));
  const decoded = SystemInstruction.decodeTransfer(ix);
  assert.ok(decoded.fromPubkey.equals(payer));
  assert.ok(decoded.toPubkey.equals(recipient));
  assert.equal(BigInt(decoded.lamports), amount);
  assert.equal(r.blockhash, conn.blockhash);
  assert.ok(r.tx.feePayer.equals(payer));
  assert.equal(r.networkFee.payment, '0.0812');

  const withMemo = await prepareSolNativeSend({
    connection: conn, payer, recipientAddress: recipient.toBase58(), amountAtomic: amount, tokenAddress: 'native', memo: 'rz123',
  });
  assert.equal(withMemo.tx.instructions.length, 2);
  assert.equal(withMemo.tx.instructions[1].data.toString('utf8'), 'rz123');
});

test('Solana native send: the guards', async () => {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey.toBase58();
  const amount = 10_000_000n; // 0.01 SOL
  const args = { payer, recipientAddress: recipient, amountAtomic: amount, tokenAddress: 'native' };
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  await rejectsWith(
    prepareSolNativeSend({ ...args, connection: solConnection({ recipientInfo: { owner: tokenProgram, executable: false } }) }),
    'DEPOSIT_ACCOUNT_NOT_WALLET',
  );
  await rejectsWith(
    prepareSolNativeSend({ ...args, connection: solConnection({ recipientInfo: { owner: SystemProgram.programId, executable: true } }) }),
    'DEPOSIT_ACCOUNT_NOT_WALLET',
  );
  // A new account: fine above rent, refused below it.
  await prepareSolNativeSend({ ...args, connection: solConnection() });
  await rejectsWith(prepareSolNativeSend({ ...args, amountAtomic: 1000n, connection: solConnection() }), 'DEPOSIT_BELOW_RENT');
  await rejectsWith(prepareSolNativeSend({ ...args, connection: solConnection({ balance: 9_999_999 }) }), 'INSUFFICIENT_BALANCE');
  // Holds the amount but would be left below rent after the fee.
  await rejectsWith(prepareSolNativeSend({ ...args, connection: solConnection({ balance: 10_005_001 }) }), 'INSUFFICIENT_GAS');
  await rejectsWith(prepareSolNativeSend({ ...args, connection: solConnection(), tokenAddress: 'So11111111111111111111111111111111111111112' }), 'NATIVE_TOKEN_ADDRESS_UNEXPECTED');
  await rejectsWith(prepareSolNativeSend({ ...args, connection: solConnection(), recipientAddress: 'not-a-key' }), 'BAD_DEPOSIT_ADDRESS');
  const failing = { ...solConnection(), async getAccountInfo() { throw new Error('rpc down'); } };
  await rejectsWith(prepareSolNativeSend({ ...args, connection: failing }), 'RPC_READ_FAILED');
});

// ---------------------------------------------------------------------------
// status: native tolerance
// ---------------------------------------------------------------------------

test('status: a native underpayment the backend moved on is followed, not escalated', () => {
  const source = { chainId: '8453', tokenSymbol: 'ETH', amount: '0.00373452', amountReceived: '0.0037', txHash: '0xabc', confirmedAt: 'x' };
  const progressed = classifyStatus({ payment: { status: 'payment_payout_completed', source }, routerState: null, coinbase: null });
  assert.notEqual(progressed.state, 'underpaid');
  assert.equal(progressed.escalate, false);
  assert.equal(progressed.moneyDetected, true);
  // Still at the pay-in: flagged as before.
  const stuck = classifyStatus({ payment: { status: 'payment_unpaid', source }, routerState: null, coinbase: null });
  assert.equal(stuck.state, 'underpaid');
  assert.equal(stuck.escalate, true);
  // A stablecoin underpayment is flagged whatever the status.
  const usdc = { ...source, tokenSymbol: 'USDC', amount: '10.00', amountReceived: '9.00' };
  assert.equal(classifyStatus({ payment: { status: 'payment_payout_completed', source: usdc }, routerState: null, coinbase: null }).state, 'underpaid');
});

// ---------------------------------------------------------------------------
// end-to-end flows with stubbed HTTP: quote, create, confirm, preflight
// ---------------------------------------------------------------------------

const LINK = 'https://payments.coinbase.com/payment-links/pl_01NATIVETESTNATIVETEST';
const LINK_ID = 'pl_01NATIVETESTNATIVETEST';
const ID = '33333333-4444-4555-8666-777777777777';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function quoteBody({ supportedSources = ALL_SOURCES, callerPays = '10.10', nativeMinUsd } = {}) {
  return {
    linkId: LINK_ID,
    protocolVersion: 'v1',
    merchant: 'OpenRouter, Inc.',
    invoice: { amount: callerPays, fiat: { amount: callerPays, currency: 'USD' } },
    quote: { callerPays },
    coinbasePayment: { id: LINK_ID, status: 'active', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(24 * 60) },
    quoteReceipt: 'receipt',
    supportedSources,
    ...(nativeMinUsd ? { nativeMinUsd } : {}),
  };
}

function nativePayment({ chainId = '8453', tokenSymbol = 'ETH', amount = '0.00373452', receiverAddress = DEPOSIT, tokenAddress = ZERO, quoteExpiresAt = inMin(60) } = {}) {
  return {
    id: ID,
    status: 'payment_unpaid',
    expiresAt: inMin(12 * 60),
    // null = the backend sent no price lock at all.
    ...(quoteExpiresAt !== null ? { quoteExpiresAt } : {}),
    source: { chainId, tokenSymbol, tokenAddress, amount, receiverAddress, senderAddress: null, txHash: null, amountReceived: null, confirmedAt: null },
    destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.10' },
  };
}

function createBody(payment, extra = {}) {
  return {
    ok: true,
    reused: false,
    linkId: LINK_ID,
    merchant: 'OpenRouter, Inc.',
    original: '10.10',
    callerPays: '10.10',
    discount: '0',
    rozoPaymentId: ID,
    expiresAt: payment.expiresAt,
    ...(payment.quoteExpiresAt ? { quoteExpiresAt: payment.quoteExpiresAt, nativeAmount: payment.source.amount } : {}),
    source: { chainId: payment.source.chainId, tokenSymbol: payment.source.tokenSymbol, tokenAddress: payment.source.tokenAddress },
    ...extra,
  };
}

const invoiceStatusBody = () => ({
  ok: true,
  pl_id: LINK_ID,
  coinbase: { protocolVersion: 'v1', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(24 * 60), settled: false },
});

async function withHttp(routes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-native-'));
  const prevDir = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const [match, respond] of routes) if (u.includes(match)) return respond(calls.at(-1));
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevDir === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const createArgs = (chain = '8453', token = 'ETH') => ['--url', LINK, '--chain', chain, '--token', token];

test('quote reports the native coins this invoice offers, inside the bounds', async () => {
  await withHttp([['/quote-invoice', () => json(quoteBody({ supportedSources: { 8453: ['USDC', 'ETH'], 1: ['USDC', 'USDT', 'ETH'], 900: ['USDC', 'USDT'] }, callerPays: '0.50' }))]], async () => {
    const { payload, exitCode } = await capture(() => runQuote(['--url', LINK]));
    assert.equal(exitCode, 0, JSON.stringify(payload));
    // Ethereum ETH is listed but the $1 minimum excludes it; SOL is not listed.
    assert.deepEqual(payload.nativeOffered.map((n) => `${n.tokenSymbol}@${n.chainId}`), ['ETH@8453']);
    assert.deepEqual(payload.routerSupportedSources[8453], ['USDC', 'ETH']);
  });
  await withHttp([['/quote-invoice', () => json(quoteBody({ supportedSources: { 8453: ['USDC'] } }))]], async () => {
    const { payload, exitCode } = await capture(() => runQuote(['--url', LINK, '--chain', '8453', '--token', 'ETH']));
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'NATIVE_NOT_OFFERED');
  });
});

test('create: a native coin the quote does not offer is refused before any order exists', async () => {
  await withHttp([['/quote-invoice', () => json(quoteBody({ supportedSources: { 8453: ['USDC'] } }))]], async (calls) => {
    const { payload, exitCode } = await capture(() => runCreateOrder(createArgs()));
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'NATIVE_NOT_OFFERED');
    assert.ok(!calls.some((c) => c.url.includes('/create-invoice')), 'nothing was created');
  });
  await withHttp([['/quote-invoice', () => json(quoteBody({ callerPays: '2500.00' }))]], async (calls) => {
    const { payload } = await capture(() => runCreateOrder(createArgs()));
    assert.equal(payload.error.code, 'NATIVE_AMOUNT_TOO_HIGH');
    assert.ok(!calls.some((c) => c.url.includes('/create-invoice')));
  });
  await withHttp([['/quote-invoice', () => json(quoteBody({ callerPays: '0.50' }))]], async () => {
    const { payload } = await capture(() => runCreateOrder(createArgs('1', 'ETH')));
    assert.equal(payload.error.code, 'NATIVE_AMOUNT_TOO_LOW');
  });
});

test('create + confirm: native order shows the price lock, records it, and confirms against it', async () => {
  const payment = nativePayment();
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(payment))],
      [`/payments/${ID}`, () => json(payment)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async (calls) => {
      const first = await capture(() => runCreateOrder(createArgs()));
      assert.equal(first.exitCode, 0, JSON.stringify(first.payload));
      assert.equal(first.payload.deposit, null, 'withheld until confirmed');
      assert.equal(first.payload.display.native, true);
      assert.equal(first.payload.display.coinAmount, '0.00373452');
      assert.equal(first.payload.display.amount, '0.00373452 ETH');
      assert.equal(first.payload.expiry.effectiveDeadlineIso, new Date(payment.quoteExpiresAt).toISOString());
      assert.ok(first.payload.confirmation.warnings.some((w) => /FX spread/.test(w)));
      const post = calls.find((c) => c.url.includes('/create-invoice'));
      assert.deepEqual(post.body.source, { chainId: '8453', tokenSymbol: 'ETH' });
      assert.equal(readState(ID).quoteExpiresAt, new Date(payment.quoteExpiresAt).toISOString());

      const conf = await capture(() => runCreateOrder([...createArgs(), '--confirm']));
      assert.equal(conf.exitCode, 0, JSON.stringify(conf.payload));
      const d = conf.payload.deposit;
      assert.equal(d.native, true);
      assert.equal(d.exactOut, true);
      assert.equal(d.amount, '0.00373452');
      assert.equal(d.receiverAddress, DEPOSIT);
      assert.equal(d.quoteExpiresAt, new Date(payment.quoteExpiresAt).toISOString());
      assert.equal(readState(ID).confirmation.quoteExpiresAt, new Date(payment.quoteExpiresAt).toISOString());
    },
  );
});

test('create: a native order without a price lock, or past it, is never shown as payable', async () => {
  const noLock = nativePayment({ quoteExpiresAt: null });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(noLock))],
      [`/payments/${ID}`, () => json(noLock)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder([...createArgs(), '--confirm']));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'EXPIRY_UNPARSABLE');
      assert.equal(payload.deposit, undefined);
    },
  );
  const stale = nativePayment({ quoteExpiresAt: inMin(-5) });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(stale, { reused: true }))],
      [`/payments/${ID}`, () => json(stale)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder([...createArgs(), '--confirm']));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'QUOTE_EXPIRED');
    },
  );
});

test('create: a blacklisted native deposit address is refused', async () => {
  const bad = nativePayment({ receiverAddress: BLACKLISTED_EVM });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(bad))],
      [`/payments/${ID}`, () => json(bad)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder([...createArgs(), '--confirm']));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'BLACKLIST_HIT');
    },
  );
});

test('preflight (Mode B): price lock, confirmed lock, blacklist and digest all hold for native orders', async () => {
  const payment = nativePayment({ chainId: '42161', quoteExpiresAt: inMin(60) });
  let live = payment;
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(payment))],
      [`/payments/${ID}`, () => json(live)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async () => {
      const conf = await capture(() => runCreateOrder([...createArgs('42161', 'ETH'), '--confirm']));
      assert.equal(conf.exitCode, 0, JSON.stringify(conf.payload));

      const ok = await preflight({ rozoPaymentId: ID, expectFamily: 'evm', senderAddress: FROM, send: true });
      assert.equal(ok.amountAtomic, toAtomic('0.00373452', 18));
      assert.equal(ok.quoteExpiresAt, new Date(payment.quoteExpiresAt).toISOString());
      await finalPayabilityCheck({ linkId: LINK_ID, chainId: '42161', intentExpiresAt: payment.expiresAt, quoteExpiresAt: ok.quoteExpiresAt });

      // The sender is checked against the compromised-wallet list too.
      await rejectsWith(preflight({ rozoPaymentId: ID, expectFamily: 'evm', senderAddress: BLACKLISTED_EVM, send: true }), 'BLACKLIST_HIT');

      // The backend now reports a LATER lock: the confirmed one still binds.
      const st = readState(ID);
      writeAtomic(statePath(ID), { ...st, confirmation: { ...st.confirmation, quoteExpiresAt: inMin(-1) } });
      live = { ...payment, quoteExpiresAt: inMin(120) };
      await rejectsWith(preflight({ rozoPaymentId: ID, expectFamily: 'evm', senderAddress: FROM, send: true }), 'QUOTE_EXPIRED');
      writeAtomic(statePath(ID), st);

      // The live lock running out also stops it, as the very last gate.
      live = { ...payment, quoteExpiresAt: inMin(-1) };
      await rejectsWith(preflight({ rozoPaymentId: ID, expectFamily: 'evm', senderAddress: FROM, send: true }), 'QUOTE_EXPIRED');
      await rejectsWith(
        finalPayabilityCheck({ linkId: LINK_ID, chainId: '42161', intentExpiresAt: payment.expiresAt, quoteExpiresAt: live.quoteExpiresAt }),
        'QUOTE_EXPIRED',
      );

      // A changed coin amount is a different deposit than the one confirmed.
      live = { ...payment, source: { ...payment.source, amount: '0.004' } };
      await rejectsWith(preflight({ rozoPaymentId: ID, expectFamily: 'evm', senderAddress: FROM, send: true }), 'CONFIRMATION_STALE');

      // Native SOL on an EVM order would need the other send script.
      live = payment;
      await rejectsWith(preflight({ rozoPaymentId: ID, expectFamily: 'solana', senderAddress: FROM, send: true }), 'WRONG_SENDER_SCRIPT');
    },
  );
});

test('Bitrefill invoices refuse native coins before any request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('network must not be reached');
  };
  try {
    const { payload, exitCode } = await capture(() =>
      runCreateBitrefill(['--invoice-id', 'bfr-1', '--to', FROM, '--amount', '7.90', '--expires-at', inMin(20), '--chain', '8453', '--token', 'ETH']),
    );
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'NATIVE_NOT_AVAILABLE');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('help text lists every native and Arbitrum preset, and never calls POL beta', async () => {
  const { HELP } = await import('../scripts/src/lib/cli-args.mjs');
  for (const p of ['eth-ethereum', 'eth-base', 'eth-arbitrum', 'bnb-bnb', 'sol-solana', 'pol-polygon', 'usdc-arbitrum', 'usdt-arbitrum']) {
    assert.ok(HELP.includes(p), p);
  }
  assert.doesNotMatch(HELP, /beta/i);
  assert.match(HELP, /\$2,000/);
  assert.match(HELP, /On-chain BTC and Tron/);
});

test('resume: the payment countdown is the earliest deadline, not the price lock alone', async () => {
  const { run: runResume } = await import('../scripts/src/resume.mjs');
  const payment = nativePayment({ quoteExpiresAt: inMin(60) });
  const status = { ok: true, pl_id: LINK_ID, coinbase: { protocolVersion: 'v1', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(20), settled: false } };
  await withHttp([['/invoice-status', () => json(status)], [`/payments/${ID}`, () => json(payment)]], async () => {
    const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
    assert.equal(exitCode, 0, JSON.stringify(payload));
    const mins = Number(String(payload.expiry.expiresIn).replace('m', ''));
    assert.ok(mins <= 20, `countdown ${payload.expiry.expiresIn} must not exceed the Coinbase link`);
    assert.equal(payload.deposit.expiresIn, payload.expiry.expiresIn);
    assert.equal(payload.expiry.quoteExpiresAt, new Date(payment.quoteExpiresAt).toISOString());
  });
});
