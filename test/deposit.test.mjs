/**
 * Deposit-instruction completeness (PLAN §3 step 6) and the fail-closed
 * receipt signal. These are the checks standing between a user and an
 * unrecoverable transfer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateDepositInstructions,
  receiptSignal,
  reuseGuard,
  classifyStatus,
  checkPayable,
} from '../scripts/src/lib/guards.mjs';
import { readFixture, clone } from './helpers.mjs';

test('Lightning: the BOLT11 lives in source.lnInvoice and receiverAddress is empty', () => {
  const ln = readFixture('payment-lightning.json');
  // This is the real serializer shape: an empty address, not a BOLT11 in it.
  assert.equal(ln.source.receiverAddress, '');
  assert.ok(ln.source.lnInvoice.startsWith('lnbc'));

  const v = validateDepositInstructions(ln.source);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.family, 'lightning');
  assert.equal(v.payTo, ln.source.lnInvoice);
  assert.equal(v.memo, null);

  // And the whole reuse guard must accept it rather than aborting DEPOSIT_NOT_LIVE.
  const guard = reuseGuard({
    payment: ln,
    requested: { chainId: 'lightning', tokenSymbol: 'BTC' },
  });
  assert.equal(guard.ok, true, guard.reason);
});

test('Lightning: no BOLT11 yet means nothing is payable', () => {
  const pending = readFixture('payment-lightning-pending-swap.json');
  const v = validateDepositInstructions(pending.source);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'DEPOSIT_INCOMPLETE');

  const guard = reuseGuard({
    payment: pending,
    requested: { chainId: 'lightning', tokenSymbol: 'BTC' },
  });
  assert.equal(guard.ok, false);
  assert.equal(guard.code, 'DEPOSIT_INCOMPLETE');
});

test('Stellar: a missing memo is a hard abort, never "no memo required"', () => {
  const stellar = readFixture('payment-unpaid-stellar.json');
  assert.equal(validateDepositInstructions(stellar.source).ok, true);

  for (const missing of [null, undefined, '', '   ']) {
    const noMemo = clone(stellar);
    noMemo.source.receiverMemo = missing;
    const v = validateDepositInstructions(noMemo.source);
    assert.equal(v.ok, false, `memo ${JSON.stringify(missing)} must be rejected`);
    assert.equal(v.code, 'DEPOSIT_MEMO_REQUIRED');

    const guard = reuseGuard({
      payment: noMemo,
      requested: { chainId: '1500', tokenSymbol: 'USDC' },
    });
    assert.equal(guard.code, 'DEPOSIT_MEMO_REQUIRED');
  }
});

test('a missing, zero, negative or malformed amount is never displayed as payable', () => {
  const base = readFixture('payment-unpaid-solana.json');
  for (const amount of [null, undefined, '', '0', '0.000000', '-5.000000', 'abc', '1e6', {}]) {
    const bad = clone(base);
    bad.source.amount = amount;
    const v = validateDepositInstructions(bad.source);
    assert.equal(v.ok, false, `amount ${JSON.stringify(amount)} must be rejected`);
    assert.equal(v.code, 'DEPOSIT_INCOMPLETE');
  }
});

test('a non-lightning order with no address is DEPOSIT_NOT_LIVE', () => {
  const base = clone(readFixture('payment-unpaid-solana.json'));
  for (const addr of [null, '', '   ']) {
    base.source.receiverAddress = addr;
    assert.equal(validateDepositInstructions(base.source).code, 'DEPOSIT_NOT_LIVE');
  }
});

test('receiptSignal fails CLOSED on a non-null amountReceived it cannot read', () => {
  const base = readFixture('payment-unpaid-solana.json').source;

  // Genuinely empty: no money.
  for (const v of [null, undefined, '']) {
    const s = receiptSignal({ ...base, amountReceived: v });
    assert.equal(s.money, false);
    assert.equal(s.unparsable, false);
  }

  // Zero: no money, but it parsed.
  assert.equal(receiptSignal({ ...base, amountReceived: '0.000000' }).money, false);

  // Unreadable: MUST be treated as money.
  for (const v of ['unknown', 'pending', '1,5', '-1', 'NaN', {}, [], '0.0000001']) {
    const s = receiptSignal({ ...base, amountReceived: v });
    assert.equal(s.money, true, `amountReceived ${JSON.stringify(v)} must count as money`);
    assert.equal(s.unparsable, true);
  }
});

test('an unreadable amountReceived blocks the reuse guard and escalates in status', () => {
  const p = clone(readFixture('payment-unpaid-solana.json'));
  p.source.amountReceived = 'unknown';

  const guard = reuseGuard({ payment: p, requested: { chainId: '900', tokenSymbol: 'USDT' } });
  assert.equal(guard.ok, false);
  assert.equal(guard.code, 'ORDER_ALREADY_FUNDED');
  assert.equal(guard.moneyDetected, true);
  assert.equal(guard.evidence.receiptUnparsable, true);

  const status = classifyStatus({ payment: p });
  assert.equal(status.state, 'stuck_after_payment');
  assert.equal(status.escalate, true);
});

test('incomplete Coinbase state is NOT provably payable', () => {
  // v1 with no usage counters.
  const incomplete = readFixture('invoice-status-incomplete.json');
  const r = checkPayable(incomplete);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LINK_PAYABILITY_UNKNOWN');

  // v1 with only one of the two counters.
  assert.equal(
    checkPayable({ coinbase: { protocolVersion: 'v1', usageCount: 0, settled: false } }).code,
    'LINK_PAYABILITY_UNKNOWN',
  );
  assert.equal(
    checkPayable({ coinbase: { protocolVersion: 'v1', maxUsage: 1, settled: false } }).code,
    'LINK_PAYABILITY_UNKNOWN',
  );
  // Non-numeric counters.
  assert.equal(
    checkPayable({
      coinbase: { protocolVersion: 'v1', usageCount: 'zero', maxUsage: 'one', settled: false },
    }).code,
    'LINK_PAYABILITY_UNKNOWN',
  );

  // v3 with no status.
  assert.equal(
    checkPayable({ coinbase: { protocolVersion: 'v3', settled: false } }).code,
    'LINK_PAYABILITY_UNKNOWN',
  );

  // The complete fixture still passes, so this is not just blanket refusal.
  assert.equal(checkPayable(readFixture('invoice-status-payable.json')).ok, true);
});

test('bridge completion is not Coinbase settlement', () => {
  const funded = readFixture('payment-funded-solana.json');
  const completed = clone(funded);
  completed.status = 'payment_completed';

  // Bridge lifecycle done, but nothing says Coinbase was paid.
  const r = classifyStatus({ payment: completed });
  assert.notEqual(r.state, 'settled');
  assert.equal(r.state, 'paying_coinbase');
  assert.equal(r.terminal, false);

  // Only real settlement evidence flips it.
  assert.equal(
    classifyStatus({ payment: completed, routerState: { status: 'paid' } }).state,
    'settled',
  );
  assert.equal(classifyStatus({ payment: completed, coinbase: { settled: true } }).state, 'settled');
});

test('an unreadable backend is `unknown`, never `awaiting_deposit`', () => {
  const r = classifyStatus({ payment: {}, viewsFailed: true });
  assert.equal(r.state, 'unknown');
  assert.equal(r.unknown, true);
  assert.equal(r.terminal, false);

  // Empty everything, without the explicit flag, is also unknown.
  assert.equal(classifyStatus({ payment: {} }).state, 'unknown');

  // An unrecognised status with no money is unknown, not "waiting".
  const weird = classifyStatus({ payment: { status: 'payment_teleported', source: {} } });
  assert.equal(weird.state, 'unknown');
  assert.equal(weird.unknown, true);
});

test('the Stellar memo type is TEXT, and is stated rather than left implicit', async () => {
  const { STELLAR_MEMO_TYPE } = await import('../scripts/src/lib/amounts.mjs');
  // Verified against rozo-intents-api: the settle path writes memo_type 'text',
  // validation is isValidMemoText (28-byte limit), per-intent memos are `rz` +
  // Crockford base32 which Memo.id() cannot represent, and monitor-stellar
  // matches by string equality. A numeric-looking memo is still TEXT.
  assert.equal(STELLAR_MEMO_TYPE, 'MEMO_TEXT');

  // The value that caused the confusion in the first real payment.
  const numericLooking = '65371582';
  assert.match(numericLooking, /^\d+$/, 'it really does look like an id');
  assert.equal(STELLAR_MEMO_TYPE, 'MEMO_TEXT', 'but it must be sent as text');
});
