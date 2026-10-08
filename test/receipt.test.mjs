/**
 * paymentOutcome, nextAction and the three-layer receipt: pure rules first,
 * then the receipt and status flows end to end with fetch stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFixture, clone } from './helpers.mjs';
import {
  PAYMENT_OUTCOMES,
  NEXT_ACTION_TYPES,
  STATE_TO_OUTCOME,
  paymentOutcomeFor,
  nextActionFor,
  buildReceipt,
  receiptExitCode,
} from '../scripts/src/lib/receipt.mjs';
import { capture } from '../scripts/src/lib/output.mjs';
import { parseCliArgs, CliError } from '../scripts/src/lib/cli-args.mjs';
import { run as runReceipt } from '../scripts/src/receipt.mjs';
import { run as runStatus } from '../scripts/src/status.mjs';
import { createOrderRecord, claimSend } from '../scripts/src/lib/state.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const EVM_TX = `0x${'ab'.repeat(32)}`;

/** A status snapshot as status.mjs builds it, clean and unpaid by default. */
function snap(over = {}) {
  return {
    provider: 'coinbase',
    rozoPaymentId: ID,
    linkId: 'pl_01TEST',
    authoritativeView: true,
    state: 'awaiting_deposit',
    unknown: false,
    moneyDetected: false,
    terminal: false,
    escalate: false,
    backend: { paymentStatus: 'payment_unpaid', routerStatus: null, coinbaseSettled: false, coinbaseStatus: 'active' },
    payin: { expected: '5.02 USDT', received: null, txHash: null, confirmedAt: null, chain: 'Solana' },
    payout: { txHash: null, confirmedAt: null },
    localSend: null,
    errors: [],
    ...over,
  };
}

// --- outcome table ------------------------------------------------------------

test('every mapped state lands on a declared outcome; unmapped states are unknown', () => {
  for (const outcome of Object.values(STATE_TO_OUTCOME)) assert.ok(PAYMENT_OUTCOMES.includes(outcome));
  assert.equal(paymentOutcomeFor(snap({ state: 'some_new_backend_state' })), 'unknown');
  assert.equal(paymentOutcomeFor(null), 'unknown');
});

test('router paid without Coinbase capture stays processing; capture proves settled', () => {
  const routerOnly = snap({
    state: 'settled',
    terminal: true,
    backend: { routerStatus: 'paid', coinbaseSettled: false, coinbaseStatus: 'PAYMENT_SESSION_STATUS_AUTHORIZED' },
  });
  assert.equal(paymentOutcomeFor(routerOnly), 'processing');
  assert.equal(buildReceipt(routerOnly).merchantSettlement.status, 'pending');
  assert.equal(buildReceipt(routerOnly).merchantSettlement.routerReportsPaid, true);

  const routerNoCoinbaseView = snap({ state: 'settled', backend: { routerStatus: 'paid', coinbaseSettled: null } });
  assert.equal(paymentOutcomeFor(routerNoCoinbaseView), 'processing');
  assert.equal(buildReceipt(routerNoCoinbaseView).merchantSettlement.status, 'unknown');

  const captured = snap({
    state: 'settled',
    terminal: true,
    backend: { routerStatus: 'paid', coinbaseSettled: true, coinbaseStatus: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED' },
  });
  assert.equal(paymentOutcomeFor(captured), 'settled');
  const r = buildReceipt(captured);
  assert.equal(r.merchantSettlement.status, 'confirmed');
  assert.equal(r.merchantSettlement.evidence, 'coinbase');
  assert.equal(r.nextAction.type, 'none');
});

test('service delivery is never inferred from settlement', () => {
  const r = buildReceipt(snap({ state: 'settled', backend: { routerStatus: 'paid', coinbaseSettled: true } }));
  assert.equal(r.serviceDelivery.status, 'unknown');
  assert.equal(r.serviceDelivery.evidence, null);
  assert.match(r.serviceDelivery.note, /not independently verified/);
});

test('partial view, unknown and escalation never read as unpaid', () => {
  assert.equal(paymentOutcomeFor(snap({ authoritativeView: false })), 'unknown');
  assert.equal(paymentOutcomeFor(snap({ authoritativeView: false, state: 'expired_unfunded' })), 'unknown');
  assert.equal(paymentOutcomeFor(snap({ unknown: true, state: 'unknown' })), 'unknown');
  assert.equal(paymentOutcomeFor(snap({ escalate: true, state: 'payin_detected', moneyDetected: true })), 'needs_attention');
  assert.equal(buildReceipt(snap({ authoritativeView: false })).sourcePayment.status, 'unknown');
});

test('money or a local send on an unpaid-looking order blocks paying again', () => {
  assert.equal(paymentOutcomeFor(snap({ moneyDetected: true })), 'processing');
  const sent = snap({ localSend: { status: 'submitted', txHash: EVM_TX, claimedAt: '2026-10-08T00:00:00Z' } });
  assert.equal(paymentOutcomeFor(sent), 'awaiting_payment');
  const action = nextActionFor(sent);
  assert.equal(action.type, 'check_status');
  assert.equal(action.canSend, false);
  assert.equal(paymentOutcomeFor({ ...sent, state: 'expired_unfunded', terminal: true }), 'needs_attention');
});

test('canSend is true only for a clean, authoritative, unfunded, live order', () => {
  const states = [...Object.keys(STATE_TO_OUTCOME), 'some_new_backend_state'];
  for (const state of states) {
    for (const moneyDetected of [false, true]) {
      for (const authoritativeView of [true, false]) {
        for (const localSend of [null, { status: 'claimed' }]) {
          const s = snap({ state, moneyDetected, authoritativeView, localSend, unknown: state === 'unknown' });
          const a = nextActionFor(s);
          assert.ok(NEXT_ACTION_TYPES.includes(a.type), `${state}: ${a.type}`);
          const clean = state === 'awaiting_deposit' && !moneyDetected && authoritativeView && !localSend;
          assert.equal(a.canSend, clean, `${state} money=${moneyDetected} view=${authoritativeView} send=${Boolean(localSend)}`);
          if (!clean && a.canCreateOrder) {
            // Only a clean expired order may start a new one.
            assert.equal(state === 'expired_unfunded' || state === 'invoice_expired', true);
            assert.equal(moneyDetected || Boolean(localSend) || !authoritativeView, false);
          }
        }
      }
    }
  }
});

test('expired unfunded: Coinbase re-orders on the same link, Bitrefill needs a new invoice', () => {
  const cb = nextActionFor(snap({ state: 'expired_unfunded', terminal: true }));
  assert.equal(cb.type, 'choose_method');
  assert.equal(cb.canCreateOrder, true);
  assert.match(cb.message, /Never fund the old deposit address/);
  const bfr = nextActionFor(snap({ provider: 'bitrefill', state: 'invoice_expired', terminal: true }));
  assert.equal(bfr.type, 'request_new_invoice');
  assert.equal(bfr.canCreateOrder, false);
});

test('receipt exit codes: 0 settled, 1 expired or needs a human, 3 otherwise', () => {
  assert.equal(receiptExitCode('settled'), 0);
  assert.equal(receiptExitCode('expired_unfunded'), 1);
  assert.equal(receiptExitCode('needs_attention'), 1);
  for (const o of ['awaiting_payment', 'processing', 'unknown']) assert.equal(receiptExitCode(o), 3);
});

test('CLI parses receipt like status, without --watch', () => {
  assert.deepEqual(parseCliArgs(['receipt', ID, '--json']), { command: 'receipt', target: ID, json: true, provider: undefined });
  assert.throws(() => parseCliArgs(['receipt']), CliError);
  assert.throws(() => parseCliArgs(['receipt', ID, '--provider', 'stripe']), CliError);
});

// --- flows, fetch stubbed -----------------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withStubs({ invoiceStatus, payment }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-receipt-'));
  const prevDir = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/invoice-status')) return json(invoiceStatus);
    if (u.includes('/payments/')) return json(payment);
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (prevDir === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prevDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function v3Settled() {
  const s = clone(readFixture('invoice-status-payable.json'));
  s.routerState = { status: 'paid', paidAt: '2026-10-08T00:05:00Z' };
  s.coinbase = {
    protocolVersion: 'v3',
    id: 'paymentSession_TEST',
    status: 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED',
    settled: true,
  };
  return s;
}

function fundedPayment() {
  const p = clone(readFixture('payment-funded-solana.json'));
  p.status = 'payment_completed';
  return p;
}

test('receipt: v3 capture succeeded exits 0 with three layers', async () => {
  await withStubs({ invoiceStatus: v3Settled(), payment: fundedPayment() }, async () => {
    const { payload, exitCode } = await capture(() => runReceipt(['--rozo-payment-id', ID]));
    assert.equal(exitCode, 0);
    assert.equal(payload.step, 'receipt');
    const r = payload.receipt;
    assert.equal(r.schemaVersion, 1);
    assert.equal(r.orderId, ID);
    assert.equal(r.paymentOutcome, 'settled');
    assert.equal(r.sourcePayment.status, 'confirmed');
    assert.equal(r.sourcePayment.txHash, '3Bxs4h24hBjHziQ8UJqSjqjbjWQq2sQ3yV9Fq4HrVh5c');
    assert.equal(r.merchantSettlement.status, 'confirmed');
    assert.equal(r.merchantSettlement.coinbaseStatus, 'PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED');
    assert.equal(r.serviceDelivery.status, 'unknown');
    assert.equal(payload.support, undefined);
  });
});

test('receipt: v3 authorized but not captured exits 3, never settled', async () => {
  const s = v3Settled();
  s.coinbase.status = 'PAYMENT_SESSION_STATUS_AUTHORIZED';
  s.coinbase.settled = false;
  await withStubs({ invoiceStatus: s, payment: fundedPayment() }, async () => {
    const { payload, exitCode } = await capture(() => runReceipt(['--rozo-payment-id', ID]));
    assert.equal(exitCode, 3);
    assert.equal(payload.receipt.paymentOutcome, 'processing');
    assert.equal(payload.receipt.merchantSettlement.status, 'pending');
    assert.equal(payload.receipt.nextAction.canSend, false);
    assert.ok(payload.support);
  });
});

test('receipt: backend unreachable exits 3 as unknown, not unpaid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-receipt-'));
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => json({ error: 'down' }, 503);
  try {
    const { payload, exitCode } = await capture(() => runReceipt(['--rozo-payment-id', ID]));
    assert.equal(exitCode, 3);
    assert.equal(payload.operationOk, false);
    assert.equal(payload.receipt.paymentOutcome, 'unknown');
    assert.equal(payload.receipt.sourcePayment.status, 'unknown');
    assert.equal(payload.receipt.nextAction.canSend, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ROZO_CHECKOUT_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt: usage errors exit 2', async () => {
  const { exitCode } = await capture(() => runReceipt([]));
  assert.equal(exitCode, 2);
});

test('status keeps its old fields and adds outcome fields; a local send blocks canSend', async () => {
  const s = clone(readFixture('invoice-status-payable.json'));
  s.rozoPayment.expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const p = clone(readFixture('payment-unpaid-solana.json'));
  p.expiresAt = s.rozoPayment.expiresAt;
  await withStubs({ invoiceStatus: s, payment: p }, async () => {
    const before = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(before.exitCode, 0);
    assert.equal(before.payload.success, true);
    assert.equal(before.payload.state, 'awaiting_deposit');
    assert.equal(before.payload.schemaVersion, 1);
    assert.equal(before.payload.paymentOutcome, 'awaiting_payment');
    assert.equal(before.payload.nextAction.type, 'pay');
    assert.equal(before.payload.nextAction.canSend, true);

    createOrderRecord({ rozoPaymentId: ID, linkId: s.pl_id, createdAt: new Date().toISOString() });
    claimSend(ID, { chainId: '900', tokenSymbol: 'USDT', from: 'a', to: 'b', amountAtomic: '1', expectedTxHash: null }, { skipCaps: true });

    const after = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(after.payload.state, 'awaiting_deposit');
    assert.equal(after.payload.localSend.status, 'claimed');
    assert.equal(after.payload.nextAction.type, 'check_status');
    assert.equal(after.payload.nextAction.canSend, false);
  });
});
