/**
 * resume: re-show an unpaid order's pay instructions, and answer clearly when
 * the order is already paid or has expired. Fetch is stubbed; nothing here
 * touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFixture, clone } from './helpers.mjs';
import { capture } from '../scripts/src/lib/output.mjs';
import { parseCliArgs, CliError, COMMANDS } from '../scripts/src/lib/cli-args.mjs';
import { run as runResume, resumeVerdict } from '../scripts/src/resume.mjs';
import { createOrderRecord, claimSend } from '../scripts/src/lib/state.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const RECEIVER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An unpaid Solana order with an hour left on both clocks. */
function liveOrder() {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const status = clone(readFixture('invoice-status-payable.json'));
  status.rozoPayment.expiresAt = expiresAt;
  status.coinbase.preApprovalExpiry = String(Math.floor(Date.now() / 1000) + 2 * 60 * 60);
  const payment = clone(readFixture('payment-unpaid-solana.json'));
  payment.expiresAt = expiresAt;
  payment.paymentLink = `https://invoice.rozo.ai/checkout?id=${ID}`;
  return { status, payment };
}

async function withStubs({ status, payment }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-resume-'));
  const prevDir = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method });
    if (u.includes('/invoice-status')) return json(status);
    if (u.includes('/payments/')) return json(payment);
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

test('CLI parses resume <rozoPaymentId> and rejects a link or nothing', () => {
  assert.ok(COMMANDS.includes('resume'));
  assert.deepEqual(parseCliArgs(['resume', ID]), { command: 'resume', target: ID, json: false, yes: false });
  assert.deepEqual(parseCliArgs(['resume', ID, '--json', '--yes']), { command: 'resume', target: ID, json: true, yes: true });
  assert.throws(() => parseCliArgs(['resume']), CliError);
  assert.throws(() => parseCliArgs(['resume', 'pl_01TEST']), (e) => e.code === 'BAD_VALUE');
});

test('resume happy path: unpaid order re-shows the pay page, address withheld until --confirm', async () => {
  const live = liveOrder();
  await withStubs(live, async (calls) => {
    const masked = await capture(() => runResume([ID]));
    assert.equal(masked.exitCode, 0);
    const p = masked.payload;
    assert.equal(p.resumable, true);
    assert.equal(p.outcome, 'awaiting_deposit');
    assert.equal(p.paymentLink, live.payment.paymentLink);
    assert.equal(p.deposit, null);
    assert.equal(p.depositWithheld, true);
    assert.ok(!JSON.stringify(p).includes(RECEIVER), 'full address must stay withheld');
    assert.equal(p.display.chain, 'Solana');
    assert.ok(p.display.payToMasked);

    const full = await capture(() => runResume([ID, '--confirm']));
    assert.equal(full.exitCode, 0);
    assert.equal(full.payload.deposit.receiverAddress, RECEIVER);
    assert.equal(full.payload.deposit.amount, '5.021000');
    assert.equal(full.payload.deposit.receiverMemo, 'rozo-901');
    assert.ok(full.payload.deposit.expiresIn);

    // Read-only: only GETs, and no order is created.
    assert.ok(calls.every((c) => (c.method ?? 'GET') === 'GET'));
    assert.ok(!calls.some((c) => c.url.includes('create-invoice')));
  });
});

test('resume on a paid order says so, exits 0 and never shows the deposit', async () => {
  const live = liveOrder();
  const payment = clone(readFixture('payment-funded-solana.json'));
  payment.status = 'payment_completed';
  const status = clone(live.status);
  status.routerState = { status: 'paid', paidAt: '2026-10-08T00:05:00Z' };
  status.coinbase.settled = true;
  await withStubs({ status, payment }, async () => {
    const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
    assert.equal(exitCode, 0);
    assert.equal(payload.resumable, false);
    assert.match(payload.outcome, /^paid/);
    assert.equal(payload.moneyDetected, true);
    assert.match(payload.message, /Do not pay again|Do NOT pay again/);
    assert.equal(payload.deposit, undefined);
  });
});

test('resume on an expired unfunded order exits 1 with a clear message', async () => {
  const { status, payment } = liveOrder();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  payment.status = 'payment_expired';
  payment.expiresAt = past;
  status.rozoPayment.status = 'payment_expired';
  status.rozoPayment.expiresAt = past;
  await withStubs({ status, payment }, async () => {
    const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
    assert.equal(exitCode, 1);
    assert.equal(payload.resumable, false);
    assert.equal(payload.outcome, 'expired');
    assert.equal(payload.error.code, 'ORDER_EXPIRED');
    assert.match(payload.error.message, /expired/);
    assert.equal(payload.deposit, undefined);
    assert.ok(payload.support);
  });
});

test('resume refuses when too little time is left, even though still unpaid', async () => {
  const { status, payment } = liveOrder();
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  payment.expiresAt = soon;
  status.rozoPayment.expiresAt = soon;
  await withStubs({ status, payment }, async () => {
    const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
    assert.equal(exitCode, 1);
    assert.equal(payload.resumable, false);
    assert.equal(payload.deposit, undefined);
  });
});

test('resume refuses when this machine already recorded a send', async () => {
  const live = liveOrder();
  await withStubs(live, async () => {
    createOrderRecord({
      rozoPaymentId: ID,
      linkId: 'pl_01TESTTESTTESTTESTTEST',
      invoiceAmount: '5.00',
      source: { chainId: '900', tokenSymbol: 'USDT' },
      receiverAddress: RECEIVER,
      amount: '5.021000',
    });
    claimSend(ID, { chainId: '900', tokenSymbol: 'USDT', from: 'x', to: RECEIVER, amountAtomic: '5021000' });
    const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'ALREADY_SENT');
    assert.equal(payload.deposit, undefined);
  });
});

test('a pay-page link on an unknown host stays redacted', async () => {
  const live = liveOrder();
  live.payment.paymentLink = `https://evil.example/pay?token=abc&id=${ID}`;
  await withStubs(live, async () => {
    const { payload } = await capture(() => runResume([ID]));
    assert.equal(payload.paymentLink, 'https://evil.example/<redacted>');
  });
});

test('resumeVerdict: unknown state is never resumable', () => {
  const v = resumeVerdict({ rozoPaymentId: ID, state: 'unknown', unknown: true, authoritativeView: false });
  assert.equal(v.resumable, false);
  assert.equal(v.code, 'ORDER_STATE_UNKNOWN');
});
