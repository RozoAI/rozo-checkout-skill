import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reuseGuard,
  verifyCreateAgainstQuote,
  checkPayable,
  classifyStatus,
  normalizeDecimal,
} from '../scripts/src/lib/guards.mjs';

import { readFixture, clone } from './helpers.mjs';

const REQUESTED = { chainId: '900', tokenSymbol: 'USDT' };

test('reuse guard: a clean unpaid order proceeds', () => {
  const payment = readFixture('payment-unpaid-solana.json');
  const r = reuseGuard({ payment, requested: REQUESTED, reused: true });
  assert.equal(r.ok, true);
  assert.equal(r.moneyDetected, false);
  assert.equal(r.evidence.reused, true);
});

test('reuse guard: aborts ORDER_ALREADY_FUNDED when any money signal is present', () => {
  const base = readFixture('payment-unpaid-solana.json');

  const withTx = clone(base);
  withTx.source.txHash = '3Bxs4h24hBjHziQ8UJqSjqjbjWQq2sQ3yV9Fq4HrVh5c';
  let r = reuseGuard({ payment: withTx, requested: REQUESTED });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ORDER_ALREADY_FUNDED');
  assert.equal(r.moneyDetected, true);

  const withReceipt = clone(base);
  withReceipt.source.amountReceived = '0.010000';
  r = reuseGuard({ payment: withReceipt, requested: REQUESTED });
  assert.equal(r.code, 'ORDER_ALREADY_FUNDED');
  assert.equal(r.moneyDetected, true);

  const withConfirm = clone(base);
  withConfirm.source.confirmedAt = '2026-08-08T10:05:00.000Z';
  r = reuseGuard({ payment: withConfirm, requested: REQUESTED });
  assert.equal(r.code, 'ORDER_ALREADY_FUNDED');
  assert.equal(r.moneyDetected, true);

  // The fully funded fixture, which still reports payment_unpaid — this is the
  // exact case the reuse rule exists for.
  const funded = readFixture('payment-funded-solana.json');
  assert.equal(funded.status, 'payment_unpaid');
  r = reuseGuard({ payment: funded, requested: REQUESTED, reused: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ORDER_ALREADY_FUNDED');
  assert.equal(r.moneyDetected, true);
});

test('reuse guard: a zero amountReceived is not money', () => {
  const p = clone(readFixture('payment-unpaid-solana.json'));
  p.source.amountReceived = '0.000000';
  assert.equal(reuseGuard({ payment: p, requested: REQUESTED }).ok, true);
});

test('reuse guard: REUSED_SOURCE_MISMATCH when the order is for another chain or token', () => {
  const p = clone(readFixture('payment-unpaid-solana.json'));
  let r = reuseGuard({ payment: p, requested: { chainId: '56', tokenSymbol: 'USDT' } });
  assert.equal(r.code, 'REUSED_SOURCE_MISMATCH');

  r = reuseGuard({ payment: p, requested: { chainId: '900', tokenSymbol: 'USDC' } });
  assert.equal(r.code, 'REUSED_SOURCE_MISMATCH');

  // Case-insensitive on the symbol only.
  r = reuseGuard({ payment: p, requested: { chainId: '900', tokenSymbol: 'usdt' } });
  assert.equal(r.ok, true);
});

test('reuse guard: non-unpaid status aborts, terminal states are not "money detected"', () => {
  const expired = clone(readFixture('payment-unpaid-solana.json'));
  expired.status = 'payment_expired';
  let r = reuseGuard({ payment: expired, requested: REQUESTED });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ORDER_NOT_PAYABLE');
  assert.equal(r.moneyDetected, false);

  const bridging = clone(readFixture('payment-unpaid-solana.json'));
  bridging.status = 'payment_bridging';
  r = reuseGuard({ payment: bridging, requested: REQUESTED });
  assert.equal(r.code, 'ORDER_ALREADY_FUNDED');
  assert.equal(r.moneyDetected, true);
});

test('reuse guard: no deposit address means DEPOSIT_NOT_LIVE', () => {
  const p = clone(readFixture('payment-unpaid-solana.json'));
  p.source.receiverAddress = null;
  assert.equal(reuseGuard({ payment: p, requested: REQUESTED }).code, 'DEPOSIT_NOT_LIVE');
});

test('post-create comparator: matching create passes', () => {
  const snapshot = readFixture('quote-snapshot.json');
  const created = readFixture('create-response.json');
  const r = verifyCreateAgainstQuote({ snapshot, created, requested: REQUESTED });
  assert.equal(r.ok, true, JSON.stringify(r.drift));
});

test('post-create comparator: trailing zeros are the same money', () => {
  assert.equal(normalizeDecimal('5.00'), normalizeDecimal('5.000000'));
  assert.equal(normalizeDecimal('05.10'), '5.1');
  assert.equal(normalizeDecimal('0'), '0');
  assert.equal(normalizeDecimal('0.0'), '0');
});

test('post-create comparator: any drift stops the run', () => {
  const snapshot = readFixture('quote-snapshot.json');

  const wrongLink = { ...readFixture('create-response.json'), linkId: 'pl_SOMETHINGELSE' };
  assert.equal(
    verifyCreateAgainstQuote({ snapshot, created: wrongLink, requested: REQUESTED }).code,
    'CREATE_DRIFT',
  );

  const wrongMerchant = { ...readFixture('create-response.json'), merchant: 'Someone Else' };
  assert.equal(
    verifyCreateAgainstQuote({ snapshot, created: wrongMerchant, requested: REQUESTED }).code,
    'CREATE_DRIFT',
  );

  const wrongAmount = { ...readFixture('create-response.json'), original: '50.000000', callerPays: '50.000000' };
  assert.equal(
    verifyCreateAgainstQuote({ snapshot, created: wrongAmount, requested: REQUESTED }).code,
    'CREATE_DRIFT',
  );

  const created = readFixture('create-response.json');
  const r = verifyCreateAgainstQuote({
    snapshot,
    created,
    requested: { chainId: '56', tokenSymbol: 'USDT' },
  });
  assert.equal(r.code, 'CREATE_DRIFT');
  assert.ok(r.drift.some((d) => d.field === 'source.chainId'));
});

test('post-create comparator: security-critical fields must be PRESENT, not just equal', () => {
  const snapshot = readFixture('quote-snapshot.json');

  // A response that simply omits a binding field must not sail through: there
  // would be no proof the order belongs to the quoted link/merchant/amount.
  for (const field of ['linkId', 'merchant', 'original', 'callerPays']) {
    for (const missing of [undefined, null, '']) {
      const created = readFixture('create-response.json');
      created[field] = missing;
      const r = verifyCreateAgainstQuote({ snapshot, created, requested: REQUESTED });
      assert.equal(r.ok, false, `${field}=${JSON.stringify(missing)} must be rejected`);
      assert.equal(r.code, 'CREATE_DRIFT');
      assert.ok(r.drift.some((d) => d.field === field));
    }
  }

  // And the echoed source must be present too.
  for (const field of ['chainId', 'tokenSymbol']) {
    const created = readFixture('create-response.json');
    delete created.source[field];
    const r = verifyCreateAgainstQuote({ snapshot, created, requested: REQUESTED });
    assert.equal(r.code, 'CREATE_DRIFT');
  }

  // A wholly absent source object is likewise a stop.
  const noSource = readFixture('create-response.json');
  delete noSource.source;
  assert.equal(
    verifyCreateAgainstQuote({ snapshot, created: noSource, requested: REQUESTED }).code,
    'CREATE_DRIFT',
  );
});

test('post-create comparator: merchant compares equal whether string or object', () => {
  const snapshot = { ...readFixture('quote-snapshot.json'), merchant: { name: 'OpenRouter, Inc.' } };
  const created = readFixture('create-response.json');
  assert.equal(verifyCreateAgainstQuote({ snapshot, created, requested: REQUESTED }).ok, true);

  const wrong = { ...created, merchant: { name: 'Someone Else' } };
  assert.equal(
    verifyCreateAgainstQuote({ snapshot, created: wrong, requested: REQUESTED }).code,
    'CREATE_DRIFT',
  );
});

test('post-create comparator: a discount on this line is a violation', () => {
  const snapshot = readFixture('quote-snapshot.json');
  const discounted = { ...readFixture('create-response.json'), discount: '0.500000' };
  assert.equal(
    verifyCreateAgainstQuote({ snapshot, created: discounted, requested: REQUESTED }).code,
    'NO_DISCOUNT_VIOLATION',
  );

  const cheaper = { ...readFixture('create-response.json'), callerPays: '4.500000' };
  const r = verifyCreateAgainstQuote({ snapshot, created: cheaper, requested: REQUESTED });
  // callerPays drift is caught against the quote first; either code is a stop.
  assert.ok(['CREATE_DRIFT', 'NO_DISCOUNT_VIOLATION'].includes(r.code));
  assert.equal(r.ok, false);
});

test('payability revalidation', () => {
  assert.equal(checkPayable(readFixture('invoice-status-payable.json')).ok, true);

  const used = readFixture('invoice-status-used.json');
  const r = checkPayable(used);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LINK_NO_LONGER_PAYABLE');

  // No Coinbase state at all is a refusal, not a pass.
  assert.equal(checkPayable({ ok: true, coinbase: null }).code, 'LINK_NO_LONGER_PAYABLE');
  assert.equal(checkPayable({}).code, 'LINK_NO_LONGER_PAYABLE');

  // v3 sessions are only payable in the CREATED state.
  const v3 = {
    coinbase: {
      protocolVersion: 'v3',
      status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
      usageCount: null,
      maxUsage: null,
      settled: false,
    },
  };
  assert.equal(checkPayable(v3).code, 'LINK_NO_LONGER_PAYABLE');
  assert.equal(
    checkPayable({ coinbase: { ...v3.coinbase, status: 'PAYMENT_SESSION_STATUS_CREATED' } }).ok,
    true,
  );

  // usageCount at maxUsage.
  assert.equal(
    checkPayable({ coinbase: { protocolVersion: 'v1', usageCount: 1, maxUsage: 1, settled: false } }).code,
    'LINK_NO_LONGER_PAYABLE',
  );
});

test('status taxonomy', () => {
  const unpaid = readFixture('payment-unpaid-solana.json');
  assert.equal(classifyStatus({ payment: unpaid, now: Date.parse('2026-08-08T10:10:00Z') }).state, 'awaiting_deposit');

  // Expired with nothing received.
  assert.equal(
    classifyStatus({ payment: unpaid, now: Date.parse('2026-08-08T12:00:00Z') }).state,
    'expired_unfunded',
  );

  const funded = readFixture('payment-funded-solana.json');
  const f = classifyStatus({ payment: funded, now: Date.parse('2026-08-08T10:10:00Z') });
  assert.equal(f.state, 'payin_detected');
  assert.equal(f.moneyDetected, true);

  const under = readFixture('payment-underpaid-bsc.json');
  const u = classifyStatus({ payment: under });
  assert.equal(u.state, 'underpaid');
  assert.equal(u.escalate, true);

  // Settlement failure after a pay-in must escalate, never read as a retryable failure.
  const stuck = classifyStatus({
    payment: funded,
    routerState: { status: 'failed_pay_invoice' },
  });
  assert.equal(stuck.state, 'stuck_after_payment');
  assert.equal(stuck.escalate, true);
  assert.equal(stuck.moneyDetected, true);

  // Expiry AFTER funding is an escalation, not "safe to retry".
  const expiredFunded = clone(funded);
  expiredFunded.status = 'payment_expired';
  const ef = classifyStatus({ payment: expiredFunded });
  assert.equal(ef.state, 'stuck_after_payment');
  assert.equal(ef.escalate, true);

  assert.equal(classifyStatus({ payment: funded, routerState: { status: 'paid' } }).state, 'settled');
  assert.equal(
    classifyStatus({ payment: { status: 'payment_payin_completed', source: {} } }).state,
    'payin_confirmed',
  );
  assert.equal(
    classifyStatus({ payment: { status: 'payment_bridging', source: {} } }).state,
    'bridging',
  );
  assert.equal(
    classifyStatus({
      payment: { status: 'payment_payout_completed', source: {} },
      routerState: { status: 'paying' },
    }).state,
    'paying_coinbase',
  );
});
