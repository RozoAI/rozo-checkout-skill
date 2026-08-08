import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toAtomic,
  satsToAtomic,
  sourceAtomic,
  comparePayment,
  decimalsFor,
  isSatsUnit,
  formatAmount,
  isSupportedSource,
  chainFamily,
  AmountError,
} from '../scripts/src/lib/amounts.mjs';

import { readFixture } from './helpers.mjs';

test('6-decimal conversion', () => {
  assert.equal(toAtomic('5.021000', 6), 5_021_000n);
  assert.equal(toAtomic('5', 6), 5_000_000n);
  assert.equal(toAtomic('0.000001', 6), 1n);
  assert.equal(toAtomic('0', 6), 0n);
});

test('18-decimal conversion (BNB Chain USDT/USDC)', () => {
  assert.equal(decimalsFor('56', 'USDT'), 18);
  assert.equal(decimalsFor('56', 'usdc'), 18);
  assert.equal(toAtomic('5.021', 18), 5_021_000_000_000_000_000n);
  // The same nominal amount is a thousand-billion times larger in atomic units
  // on BNB Chain than on Ethereum — this is exactly the bug the table prevents.
  assert.notEqual(toAtomic('5.021', 18), toAtomic('5.021', 6));
});

test('per-chain decimals table', () => {
  assert.equal(decimalsFor('1', 'USDT'), 6);
  assert.equal(decimalsFor('137', 'USDC'), 6);
  assert.equal(decimalsFor('8453', 'USDC'), 6);
  assert.equal(decimalsFor('900', 'USDT'), 6);
  assert.equal(decimalsFor('1500', 'USDC'), 7);
  assert.throws(() => decimalsFor('56', 'DAI'), (e) => e.code === 'UNKNOWN_DECIMALS');
  // Lightning has no decimals at all — asking must fail, not default to 8.
  assert.throws(() => decimalsFor('lightning', 'BTC'), (e) => e.code === 'UNKNOWN_DECIMALS');
});

test('rejects malformed and over-precise amounts', () => {
  assert.throws(() => toAtomic('abc', 6), AmountError);
  assert.throws(() => toAtomic('-1.0', 6), (e) => e.code === 'BAD_AMOUNT');
  assert.throws(() => toAtomic('1e6', 6), (e) => e.code === 'BAD_AMOUNT');
  assert.throws(() => toAtomic('1.0000001', 6), (e) => e.code === 'AMOUNT_PRECISION');
  // Trailing zeros beyond precision are harmless.
  assert.equal(toAtomic('1.0000000', 6), 1_000_000n);
});

test('lightning amounts are integer sats, never BTC decimals', () => {
  assert.ok(isSatsUnit('sats'));
  assert.ok(isSatsUnit('SATS'));
  assert.ok(!isSatsUnit('btc'));
  assert.ok(!isSatsUnit(undefined));
  assert.equal(satsToAtomic('8421'), 8421n);
  assert.throws(() => satsToAtomic('8421.5'), (e) => e.code === 'BAD_SATS');

  const ln = readFixture('payment-lightning.json');
  assert.equal(sourceAtomic(ln.source, 'amount'), 8421n);
  assert.equal(formatAmount(ln.source), '8421 sats');
  // It must never be described as BTC.
  assert.ok(!formatAmount(ln.source).includes('BTC'));
});

test('comparePayment: none / exact / underpaid / overpaid', () => {
  const unpaid = readFixture('payment-unpaid-solana.json');
  assert.equal(comparePayment(unpaid.source).state, 'none');

  const funded = readFixture('payment-funded-solana.json');
  assert.equal(comparePayment(funded.source).state, 'exact');

  const under = readFixture('payment-underpaid-bsc.json');
  const cmp = comparePayment(under.source);
  assert.equal(cmp.state, 'underpaid');
  // 18-decimal math, not 6.
  assert.equal(cmp.expectedAtomic, '5021000000000000000');
  assert.equal(cmp.receivedAtomic, '4000000000000000000');
  assert.equal(cmp.deltaAtomic, '-1021000000000000000');

  const over = { ...funded.source, amountReceived: '5.500000' };
  assert.equal(comparePayment(over).state, 'overpaid');

  // Zero received is "none", not "underpaid" — nothing has arrived.
  assert.equal(comparePayment({ ...unpaid.source, amountReceived: '0.000000' }).state, 'none');
});

test('supported source whitelist includes Lightning and excludes native SOL', () => {
  assert.ok(isSupportedSource('900', 'USDT'));
  assert.ok(isSupportedSource('900', 'usdc'));
  assert.ok(!isSupportedSource('900', 'SOL'));
  assert.ok(isSupportedSource('lightning', 'BTC'));
  assert.ok(isSupportedSource('56', 'USDT'));
  // Base and Stellar are USDC-only.
  assert.ok(!isSupportedSource('8453', 'USDT'));
  assert.ok(!isSupportedSource('1500', 'USDT'));
});

test('chain families', () => {
  assert.equal(chainFamily('8453'), 'evm');
  assert.equal(chainFamily('900'), 'solana');
  assert.equal(chainFamily('1500'), 'stellar');
  assert.equal(chainFamily('lightning'), 'lightning');
  assert.equal(chainFamily('99999'), null);
});
