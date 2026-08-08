/**
 * The binding-confirmation rail (PLAN §3 step 6b).
 *
 * A confirmation is only meaningful if it is bound to the exact deposit
 * instructions the human was shown. These tests cover the digest binding and
 * the state transitions; the flag enforcement itself is covered by
 * entrypoints.test.mjs, which runs the real scripts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFixture, clone } from './helpers.mjs';

const {
  createOrderRecord,
  readState,
  recordConfirmation,
  depositDigest,
} = await import('../scripts/src/lib/state.mjs');

const ID = '11111111-2222-4333-8444-555555555555';

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-conf-'));
  const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function orderFrom(payment) {
  return {
    rozoPaymentId: ID,
    linkId: 'pl_01TESTTESTTESTTESTTEST',
    merchant: 'OpenRouter, Inc.',
    invoiceAmount: '5.000000',
    source: { chainId: payment.source.chainId, tokenSymbol: payment.source.tokenSymbol },
    receiverAddress: payment.source.receiverAddress,
    receiverMemo: payment.source.receiverMemo ?? null,
    amount: payment.source.amount,
    expiresAt: payment.expiresAt,
  };
}

test('a fresh order carries no confirmation', () => {
  withTempStateDir(() => {
    const payment = readFixture('payment-unpaid-solana.json');
    createOrderRecord(orderFrom(payment));
    assert.equal(readState(ID).confirmation, null);
  });
});

test('confirming binds a digest of the exact deposit instructions', () => {
  withTempStateDir(() => {
    const payment = readFixture('payment-unpaid-solana.json');
    createOrderRecord(orderFrom(payment));
    const after = recordConfirmation(ID, {
      source: payment.source,
      invoiceAmount: '5.000000',
      tier: 'one-line',
    });
    assert.ok(after.confirmation.confirmedAt);
    assert.equal(after.confirmation.depositDigest, depositDigest(payment.source));
    assert.equal(after.confirmation.tier, 'one-line');
  });
});

test('the digest changes when ANY payable field changes', () => {
  const base = readFixture('payment-unpaid-solana.json').source;
  const original = depositDigest(base);

  const mutations = [
    ['receiverAddress', 'AttackerAddress1111111111111111111111111111'],
    ['receiverMemo', 'rozo-999'],
    ['amount', '50.021000'],
    ['tokenSymbol', 'USDC'],
    ['chainId', '56'],
    ['tokenAddress', 'SoMeOtherMint1111111111111111111111111111111'],
    ['amountUnit', 'sats'],
    ['lnInvoice', 'lnbc1attacker'],
  ];
  for (const [field, value] of mutations) {
    const mutated = { ...base, [field]: value };
    assert.notEqual(depositDigest(mutated), original, `${field} must be covered by the digest`);
  }

  // Identical input is stable.
  assert.equal(depositDigest(clone(base)), original);
});

test('a confirmation survives the order record being rewritten', () => {
  withTempStateDir(() => {
    const payment = readFixture('payment-unpaid-solana.json');
    createOrderRecord(orderFrom(payment));
    recordConfirmation(ID, { source: payment.source, invoiceAmount: '5.000000' });
    createOrderRecord(orderFrom(payment));
    assert.ok(readState(ID).confirmation, 'confirmation must not be lost on re-create');
  });
});

test('confirming an order that does not exist locally is refused', () => {
  withTempStateDir(() => {
    const payment = readFixture('payment-unpaid-solana.json');
    assert.throws(
      () => recordConfirmation(ID, { source: payment.source }),
      (e) => e.code === 'NO_ORDER_STATE',
    );
  });
});
