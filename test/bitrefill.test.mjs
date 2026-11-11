/**
 * Bitrefill invoices: local validation, router echo verification, the
 * duplicate-invoice resume path, provider-aware status and CLI parsing.
 * No network: fetch is stubbed per test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFixture, clone } from './helpers.mjs';
import {
  validateBitrefillInput,
  verifyBitrefillCreate,
  verifyBitrefillDestination,
  duplicateInvoicePaymentId,
  checkBitrefillPricing,
  bitrefillPricingDrift,
  BITREFILL_FUNDER,
} from '../scripts/src/lib/bitrefill.mjs';
import { classifyStatus } from '../scripts/src/lib/guards.mjs';
import { parseCliArgs, CliError } from '../scripts/src/lib/cli-args.mjs';
import { capture } from '../scripts/src/lib/output.mjs';
import { MPP_BASE, CLIENT_LABEL } from '../scripts/src/lib/api.mjs';
import { run as runBitrefill } from '../scripts/src/create-bitrefill-order.mjs';
import { run as runStatus } from '../scripts/src/status.mjs';
import { readState } from '../scripts/src/lib/state.mjs';

const ADDR = '0x1234567890abcdef1234567890ABCDEF12345678';
const ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString();
const ARGS = ['--invoice-id', 'bfr-test-7f3a2', '--to', ADDR, '--amount', '7.90', '--expires-at', inMin(20), '--chain', '1500', '--token', 'USDC'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withEnv(routes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-bfr-'));
  const prevDir = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
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

// --- local validation ------------------------------------------------------

test('valid invoice facts are normalized', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const v = validateBitrefillInput({ invoiceId: 'bfr-1', address: ADDR, amount: '7.900', expiresAt: '2026-10-01T00:20:00Z' }, now);
  assert.deepEqual(v, { invoiceId: 'bfr-1', address: ADDR, amount: '7.9', expiresAt: '2026-10-01T00:20:00.000Z' });
});

test('bad address, amount and id are refused locally', () => {
  const base = { invoiceId: 'bfr-1', address: ADDR, amount: '7.90', expiresAt: inMin(20) };
  for (const [patch, code] of [
    [{ address: '0x123' }, 'INVALID_ADDRESS'],
    [{ address: 'GCEXAMPLE' }, 'INVALID_ADDRESS'],
    [{ amount: '0' }, 'INVALID_AMOUNT'],
    [{ amount: '-1' }, 'INVALID_AMOUNT'],
    [{ amount: '1.1234567' }, 'INVALID_AMOUNT'],
    [{ amount: '1e3' }, 'INVALID_AMOUNT'],
    [{ invoiceId: '' }, 'BAD_BITREFILL_INVOICE'],
    [{ invoiceId: 'a b' }, 'BAD_BITREFILL_INVOICE'],
    [{ expiresAt: undefined }, 'INVOICE_EXPIRY_REQUIRED'],
    [{ expiresAt: inMin(4) }, 'INVOICE_EXPIRING'],
    [{ expiresAt: inMin(61.5) }, 'INVOICE_EXPIRING'],
    [{ expiresAt: inMin(90) }, 'INVOICE_EXPIRING'],
  ]) {
    assert.throws(() => validateBitrefillInput({ ...base, ...patch }), (e) => e.code === code, JSON.stringify(patch));
  }
});

test('a freshly created Bitrefill invoice (up to 60 minutes left) is accepted', () => {
  const base = { invoiceId: 'bfr-1', address: ADDR, amount: '7.90' };
  for (const m of [6, 30, 45, 59, 60]) {
    const out = validateBitrefillInput({ ...base, expiresAt: inMin(m) });
    assert.equal(typeof out.expiresAt, 'string', String(m));
  }
});

test('an invoice with under 5 minutes left is refused', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.throws(
    () => validateBitrefillInput({ invoiceId: 'bfr-1', address: ADDR, amount: '1', expiresAt: '2026-10-01T00:04:00Z' }, now),
    (e) => e.code === 'INVOICE_EXPIRING',
  );
  const ok = validateBitrefillInput({ invoiceId: 'bfr-1', address: ADDR, amount: '1', expiresAt: '2026-10-01T00:06:00Z' }, now);
  assert.equal(ok.expiresAt, '2026-10-01T00:06:00.000Z');
});

// --- echo verification -----------------------------------------------------

test('router echo matches the requested invoice (address case-insensitive, amount normalized)', () => {
  const created = readFixture('bitrefill-create-response.json');
  const v = verifyBitrefillCreate({ requested: { invoiceId: 'bfr-test-7f3a2', address: ADDR.toLowerCase(), amount: '7.9' }, created });
  assert.equal(v.ok, true);
});

test('any echo drift aborts', () => {
  const requested = { invoiceId: 'bfr-test-7f3a2', address: ADDR, amount: '7.9' };
  for (const mutate of [
    (c) => { c.destination.address = '0x0000000000000000000000000000000000000001'; },
    (c) => { c.destination.amount = '7.91'; },
    (c) => { c.invoiceId = 'other'; },
    (c) => { c.destination.chainId = '1'; },
    (c) => { c.provider = 'coinbase'; },
  ]) {
    const c = clone(readFixture('bitrefill-create-response.json'));
    mutate(c);
    const v = verifyBitrefillCreate({ requested, created: c });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'BITREFILL_ECHO_MISMATCH');
  }
});

test('live intent destination must match too', () => {
  const requested = { invoiceId: 'x', address: ADDR, amount: '7.9' };
  const payment = readFixture('payment-bitrefill-unpaid-stellar.json');
  assert.equal(verifyBitrefillDestination({ requested, payment }).ok, true);
  assert.equal(verifyBitrefillDestination({ requested, payment }).addressVerified, true);
  const bad = clone(payment);
  bad.destination.amount = '8';
  assert.equal(verifyBitrefillDestination({ requested, payment: bad }).ok, false);
  const noAddr = clone(payment);
  delete noAddr.destination.receiverAddress;
  const v = verifyBitrefillDestination({ requested, payment: noAddr });
  assert.equal(v.ok, false, 'missing live address fails closed');
  assert.equal(v.code, 'BITREFILL_ECHO_MISMATCH');
});

test('DUPLICATE_INVOICE exposes the existing order id', () => {
  assert.equal(duplicateInvoicePaymentId({ code: 'DUPLICATE_INVOICE', details: { body: { rozoPaymentId: ID } } }), ID);
  assert.equal(duplicateInvoicePaymentId({ code: 'INVALID_AMOUNT', details: { body: {} } }), null);
});

// --- the flow ---------------------------------------------------------------

test('create flow: posts the bitrefill contract, withholds deposit, records provider', async () => {
  await withEnv(
    [
      ['/create-invoice', () => json(readFixture('bitrefill-create-response.json'))],
      [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
    ],
    async (calls) => {
      const { payload, exitCode } = await capture(() => runBitrefill(ARGS));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.equal(payload.provider, 'bitrefill');
      assert.equal(payload.deposit, null);
      assert.equal(payload.depositWithheld, true);
      const post = calls.find((c) => c.url === `${MPP_BASE}/create-invoice`);
      assert.deepEqual(post.body.bitrefill, { invoiceId: 'bfr-test-7f3a2', address: ADDR, amount: '7.9', expiresAt: ARGS[ARGS.indexOf('--expires-at') + 1] });
      assert.equal(post.body.provider, 'bitrefill');
      assert.deepEqual(post.body.source, { chainId: '1500', tokenSymbol: 'USDC' });
      assert.equal(post.body.client, CLIENT_LABEL);
      assert.ok(!calls.some((c) => c.url.includes('invoice-status')), 'no Coinbase reads');
      assert.ok(!calls.some((c) => c.method === 'POST' && c.url.includes('payment-api')), 'never writes payment-api');
      const st = readState(ID);
      assert.equal(st.provider, 'bitrefill');
      assert.equal(st.bitrefill.address, ADDR);

      const conf = await capture(() => runBitrefill([...ARGS, '--confirm']));
      assert.equal(conf.exitCode, 0);
      assert.equal(conf.payload.deposit.receiverMemo, 'rozo-9921');
      assert.ok(readState(ID).confirmation);
    },
  );
});

test('create flow: router echo mismatch aborts before any deposit is shown', async () => {
  const bad = clone(readFixture('bitrefill-create-response.json'));
  bad.destination.address = '0x9999999999999999999999999999999999999999';
  await withEnv(
    [
      ['/create-invoice', () => json(bad)],
      [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
    ],
    async (calls) => {
      const { payload, exitCode } = await capture(() => runBitrefill([...ARGS, '--confirm']));
      assert.notEqual(exitCode, 0);
      assert.equal(payload.error.code, 'BITREFILL_ECHO_MISMATCH');
      assert.equal(payload.deposit, undefined);
      assert.equal(readState(ID), null);
      assert.ok(!calls.some((c) => c.url.includes('/payments/')));
    },
  );
});

test('create flow: DUPLICATE_INVOICE resumes the existing order', async () => {
  await withEnv(
    [
      ['/create-invoice', () => json({ ok: false, error: 'DUPLICATE_INVOICE', message: 'exists', rozoPaymentId: ID }, 409)],
      [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runBitrefill(ARGS));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.equal(payload.reused, true);
      assert.equal(payload.rozoPaymentId, ID);
    },
  );
});

test('contactEmailProvided: true on a fresh order with --email, false when resumed or absent', async () => {
  const fresh = [
    ['/create-invoice', () => json(readFixture('bitrefill-create-response.json'))],
    [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
  ];
  await withEnv(fresh, async (calls) => {
    const { payload, exitCode } = await capture(() => runBitrefill([...ARGS, '--email', 'Buyer@Example.com']));
    assert.equal(exitCode, 0, JSON.stringify(payload));
    assert.equal(payload.contactEmailProvided, true);
    assert.equal(calls.find((c) => c.url === `${MPP_BASE}/create-invoice`).body.email, 'buyer@example.com');
    assert.ok(!JSON.stringify(payload).includes('buyer@example.com'), 'address never echoed');
  });
  await withEnv(fresh, async () => {
    const { payload } = await capture(() => runBitrefill(ARGS));
    assert.equal(payload.contactEmailProvided, false);
  });
  await withEnv(
    [
      ['/create-invoice', () => json({ ok: false, error: 'DUPLICATE_INVOICE', message: 'exists', rozoPaymentId: ID }, 409)],
      [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runBitrefill([...ARGS, '--email', 'buyer@example.com']));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.equal(payload.reused, true);
      assert.equal(payload.contactEmailProvided, false);
    },
  );
});

test('create flow: router error codes surface unchanged', async () => {
  await withEnv(
    [['/create-invoice', () => json({ ok: false, error: 'BITREFILL_DISABLED', message: 'off' }, 403)]],
    async () => {
      const { payload } = await capture(() => runBitrefill(ARGS));
      assert.equal(payload.error.code, 'BITREFILL_DISABLED');
    },
  );
});

test('create flow: blacklisted destination is refused before any request', async () => {
  const bl = JSON.parse(fs.readFileSync(new URL('../scripts/src/lib/blacklist.json', import.meta.url)));
  const evm = JSON.stringify(bl).match(/0x[0-9a-fA-F]{40}/)[0];
  await withEnv([], async (calls) => {
    const args = [...ARGS];
    args[3] = evm;
    const { payload } = await capture(() => runBitrefill(args));
    assert.equal(payload.error.code, 'BLACKLIST_HIT');
    assert.equal(calls.length, 0);
  });
});

// --- status -----------------------------------------------------------------

test('classifyStatus: bitrefill payout completed is settled, no paying_coinbase stage', () => {
  const payout = classifyStatus({ payment: { status: 'payment_payout_completed', source: {} }, provider: 'bitrefill' });
  assert.equal(payout.state, 'settled');
  assert.equal(payout.terminal, true);
  const doneNoTx = classifyStatus({ payment: { status: 'payment_completed', source: {}, destination: {} }, provider: 'bitrefill' });
  assert.equal(doneNoTx.state, 'bridging');
  const doneTx = classifyStatus({ payment: { status: 'payment_completed', source: {}, destination: { txHash: '0xabc' } }, provider: 'bitrefill' });
  assert.equal(doneTx.state, 'settled');
  const cb = classifyStatus({ payment: { status: 'payment_completed', source: {} } });
  assert.equal(cb.state, 'paying_coinbase');
  const awaiting = classifyStatus({
    payment: { status: 'payment_unpaid', expiresAt: '2099-01-01T00:00:00Z', source: {} },
    provider: 'bitrefill',
  });
  assert.equal(awaiting.state, 'awaiting_deposit');
});

test('status command reads only the intent for a bitrefill order', async () => {
  const done = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  done.status = 'payment_payout_completed';
  done.source.txHash = 'abc';
  done.source.amountReceived = done.source.amount;
  done.source.confirmedAt = '2026-10-01T00:00:00Z';
  await withEnv([[`/payments/${ID}`, () => json(done)]], async (calls) => {
    const { payload, exitCode } = await capture(() => runStatus(['--rozo-payment-id', ID, '--provider', 'bitrefill']));
    assert.equal(exitCode, 0, JSON.stringify(payload));
    assert.equal(payload.state, 'settled');
    assert.equal(payload.provider, 'bitrefill');
    assert.ok(!calls.some((c) => c.url.includes('invoice-status')));
  });
});

// --- CLI parsing ------------------------------------------------------------

test('CLI parses a bitrefill pay', () => {
  const o = parseCliArgs(['pay', '--bitrefill-invoice', 'bfr-1', '--to', ADDR, '--amount', '7.90', '--expires-at', '2099-01-01T00:00:00Z', '--from', 'stellar-usdc']);
  assert.throws(() => parseCliArgs(['pay', '--bitrefill-invoice', 'bfr-1', '--to', ADDR, '--amount', '1', '--with', 'usdc-base']), CliError, 'expiry required');
  assert.equal(o.command, 'pay');
  assert.equal(o.target, null);
  assert.deepEqual(o.bitrefill, { invoiceId: 'bfr-1', address: ADDR, amount: '7.90', expiresAt: '2099-01-01T00:00:00Z' });
  assert.deepEqual(o.source, { chainId: '1500', tokenSymbol: 'USDC' });
  const w = parseCliArgs(['pay', '--bitrefill-invoice', 'bfr-1', '--to', ADDR, '--amount', '1', '--expires-at', 'x', '--with', 'usdt-solana']);
  assert.deepEqual(w.source, { chainId: '900', tokenSymbol: 'USDT' });
});

test('CLI rejects incomplete or conflicting bitrefill args', () => {
  assert.throws(() => parseCliArgs(['pay', '--bitrefill-invoice', 'b', '--to', ADDR]), CliError);
  assert.throws(() => parseCliArgs(['pay', 'pl_x', '--bitrefill-invoice', 'b', '--to', ADDR, '--amount', '1']), CliError);
  assert.throws(() => parseCliArgs(['pay', '--bitrefill-invoice', 'b', '--to', ADDR, '--amount', '1', '--with', 'usdc-base', '--from', 'usdc-base']), CliError);
  assert.throws(() => parseCliArgs(['status', ID, '--provider', 'stripe']), CliError);
});

test('presend final check for bitrefill re-reads the intent, never invoice-status', async () => {
  const { finalPayabilityCheck } = await import('../scripts/src/lib/presend.mjs');
  const state = {
    rozoPaymentId: ID,
    provider: 'bitrefill',
    source: { chainId: '1500', tokenSymbol: 'USDC' },
    bitrefill: { invoiceId: 'bfr-test-7f3a2', address: ADDR, amount: '7.9', expiresAt: inMin(20) },
  };
  await withEnv([[`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))]], async (calls) => {
    const r = await finalPayabilityCheck({ linkId: null, chainId: '1500', state, rozoPaymentId: ID });
    assert.equal(r.statusNow, null);
    assert.ok(!calls.some((c) => c.url.includes('invoice-status')));
  });
  const funded = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  funded.source.txHash = 'abc';
  await withEnv([[`/payments/${ID}`, () => json(funded)]], async () => {
    await assert.rejects(
      finalPayabilityCheck({ linkId: null, chainId: '1500', state, rozoPaymentId: ID }),
      (e) => e.code === 'ORDER_ALREADY_FUNDED',
    );
  });
  const expiring = { ...state, bitrefill: { ...state.bitrefill, expiresAt: inMin(1) } };
  await withEnv([[`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))]], async () => {
    await assert.rejects(
      finalPayabilityCheck({ linkId: null, chainId: '1500', state: expiring, rozoPaymentId: ID }),
      (e) => /EXPIR/.test(e.code),
    );
  });
});

test('presend final check aborts when the live destination drifts or is missing', async () => {
  const { finalPayabilityCheck } = await import('../scripts/src/lib/presend.mjs');
  const state = {
    rozoPaymentId: ID,
    provider: 'bitrefill',
    source: { chainId: '1500', tokenSymbol: 'USDC' },
    bitrefill: { invoiceId: 'bfr-test-7f3a2', address: ADDR, amount: '7.9', expiresAt: inMin(20) },
  };
  for (const mutate of [
    (p) => { p.destination.receiverAddress = '0x9999999999999999999999999999999999999999'; },
    (p) => { delete p.destination.receiverAddress; },
    (p) => { p.destination.amount = '8'; },
    (p) => { p.destination.chainId = '1'; },
  ]) {
    const live = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
    mutate(live);
    await withEnv([[`/payments/${ID}`, () => json(live)]], async () => {
      await assert.rejects(
        finalPayabilityCheck({ linkId: null, chainId: '1500', state, rozoPaymentId: ID }),
        (e) => e.code === 'BITREFILL_ECHO_MISMATCH',
      );
    });
  }
});

test('create flow: missing live destination address aborts (fresh and DUPLICATE resume)', async () => {
  const live = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  delete live.destination.receiverAddress;
  for (const create of [
    () => json(readFixture('bitrefill-create-response.json')),
    () => json({ ok: false, error: 'DUPLICATE_INVOICE', message: 'exists', rozoPaymentId: ID }, 409),
  ]) {
    await withEnv([['/create-invoice', create], [`/payments/${ID}`, () => json(live)]], async () => {
      const { payload } = await capture(() => runBitrefill([...ARGS, '--confirm']));
      assert.equal(payload.error.code, 'BITREFILL_ECHO_MISMATCH');
      assert.equal(payload.deposit, undefined);
      assert.equal(readState(ID), null);
    });
  }
});

test('create flow: expiry is the invoice only; under 5 min refuses to create, Rozo expiry ignored', async () => {
  const args = [...ARGS];
  args[args.indexOf('--expires-at') + 1] = inMin(4);
  await withEnv([], async (calls) => {
    const { payload } = await capture(() => runBitrefill(args));
    assert.equal(payload.error.code, 'INVOICE_EXPIRING');
    assert.equal(calls.length, 0);
  });
  // A Rozo intent that "expires" in the past does not matter; the invoice clock does.
  const live = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  live.expiresAt = '2000-01-01T00:00:00Z';
  await withEnv(
    [['/create-invoice', () => json(readFixture('bitrefill-create-response.json'))], [`/payments/${ID}`, () => json(live)]],
    async () => {
      const { payload, exitCode } = await capture(() => runBitrefill(ARGS));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.equal(payload.expiry.invoiceExpiresAt, ARGS[ARGS.indexOf('--expires-at') + 1]);
    },
  );
});

test('create flow: 503 / 400 router errors get clear messages', async () => {
  for (const [status, code, needle] of [
    [503, 'BITREFILL_NOT_CONFIGURED', 'not configured'],
    [503, 'RETRY_LATER', 'retry'],
    [400, 'INVALID_INPUT', 'rejected the invoice details'],
  ]) {
    await withEnv([['/create-invoice', () => json({ ok: false, error: code, message: 'x' }, status)]], async () => {
      const { payload } = await capture(() => runBitrefill(ARGS));
      assert.equal(payload.error.code, code);
      assert.match(payload.error.message, new RegExp(needle, 'i'));
    });
  }
});

test('status without a local record detects bitrefill from the orderId prefix', async () => {
  const live = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  live.orderId = 'bitrefill_bfr-test-7f3a2';
  live.status = 'payment_completed';
  live.source.txHash = 'abc';
  live.source.amountReceived = live.source.amount;
  live.source.confirmedAt = '2026-10-01T00:00:00Z';
  live.destination.txHash = '0xpayout';
  await withEnv([[`/payments/${ID}`, () => json(live)]], async (calls) => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.provider, 'bitrefill');
    assert.equal(payload.state, 'settled');
    assert.ok(!calls.some((c) => c.url.includes('invoice-status')));
  });
});

test('resume never extends the deadline (local record, intent metadata, supplied)', async () => {
  await withEnv(
    [
      ['/create-invoice', () => json({ ok: false, error: 'DUPLICATE_INVOICE', message: 'exists', rozoPaymentId: ID }, 409)],
      [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
    ],
    async () => {
      const early = inMin(10);
      const first = [...ARGS];
      first[first.indexOf('--expires-at') + 1] = early;
      assert.equal((await capture(() => runBitrefill(first))).exitCode, 0);
      // A later --expires-at on resume must not move the stored deadline.
      const later = [...ARGS];
      later[later.indexOf('--expires-at') + 1] = inMin(25);
      const r = await capture(() => runBitrefill(later));
      assert.equal(r.payload.expiry.invoiceExpiresAt, early);
      assert.equal(readState(ID).bitrefill.expiresAt, early);
    },
  );
  const live = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  const metaExp = inMin(3);
  live.metadata = { bitrefillExpiresAt: metaExp };
  await withEnv(
    [['/create-invoice', () => json(readFixture('bitrefill-create-response.json'))], [`/payments/${ID}`, () => json(live)]],
    async () => {
      const r = await capture(() => runBitrefill(ARGS));
      assert.equal(r.payload.expiry.invoiceExpiresAt, metaExp);
      assert.equal(JSON.stringify(r.payload).includes('paymentLink'), false, 'no Rozo hosted link for bitrefill');
    },
  );
});

test('status: bitrefill deadline unknown is not payable; past deadline is invoice_expired', async () => {
  const live = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  live.orderId = 'bitrefill_x';
  await withEnv([[`/payments/${ID}`, () => json(live)]], async () => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.state, 'deadline_unknown');
    assert.equal(payload.expiry.deadlineUnknown, true);
  });
  const past = clone(live);
  past.metadata = { bitrefillExpiresAt: '2020-01-01T00:00:00Z' };
  await withEnv([[`/payments/${ID}`, () => json(past)]], async () => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.state, 'invoice_expired');
    assert.equal(payload.terminal, true);
  });
  const ok = clone(live);
  ok.metadata = { bitrefillExpiresAt: inMin(15) };
  await withEnv([[`/payments/${ID}`, () => json(ok)]], async () => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.state, 'awaiting_deposit');
    assert.equal(payload.expiry.expiresAt, ok.metadata.bitrefillExpiresAt);
  });
});

// --- service fee: funder model (mpprouter #315, founder 2026-11-11) ---------
// 1% of the invoice, rounded UP to the cent, read from the router's
// Coinbase-line fee fields; the live order pays the funder invoice + fee and
// freezes the invoice facts in metadata.bitrefill.

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const atomic = (d) => {
  const [w, f = ''] = String(d).split('.');
  return (BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'))).toString();
};

function funderOrder({ invoice = '204.37', fee = '2.05', total = '206.42', deposit = '206.5000000', expiresAt = inMin(20) } = {}) {
  const p = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  p.orderId = `bitrefill_${UUID}`;
  p.source.amount = deposit;
  p.destination = { chainId: '8453', tokenSymbol: 'USDC', receiverAddress: BITREFILL_FUNDER, amount: total };
  p.metadata = {
    provider: 'bitrefill',
    bitrefillInvoiceId: UUID,
    bitrefillExpiresAt: expiresAt,
    original: invoice,
    serviceFee: fee,
    callerPays: total,
    feeBps: 100,
    pricingVersion: 'v1',
    bitrefill: {
      v: 1,
      invoiceId: UUID,
      address: ADDR.toLowerCase(),
      amountAtomic: atomic(invoice),
      expiresAt,
      feeBps: 100,
      serviceFeeAtomic: atomic(fee),
      callerPaysAtomic: atomic(total),
      binding: 'ab'.repeat(32),
    },
  };
  return p;
}
function funderCreate({ invoice = '204.37', fee = '2.05', total = '206.42' } = {}) {
  return {
    ok: true,
    provider: 'bitrefill',
    model: 'funder',
    invoiceId: UUID,
    rozoPaymentId: ID,
    destination: { chainId: '8453', tokenSymbol: 'USDC', address: ADDR, amount: invoice },
    original: invoice,
    serviceFee: fee,
    feeBps: 100,
    callerPays: total,
    callerPaysAtomicUsdc: atomic(total),
    pricingVersion: 'v1',
    expiresAt: inMin(20),
  };
}
const FARGS = (over = {}) => {
  const a = ['--invoice-id', UUID.toUpperCase(), '--to', ADDR, '--amount', over.amount ?? '204.37', '--expires-at', over.expiresAt ?? inMin(20), '--chain', over.chain ?? '1500', '--token', over.token ?? 'USDC'];
  return a;
};
const requestedFor = (amount = '204.37') => ({ invoiceId: UUID, address: ADDR, amount });

test('funder fee: 204.37 -> fee 2.05 (cent round up), total 206.42, rest of the deposit is the bridge fee', () => {
  const live = verifyBitrefillDestination({ requested: requestedFor(), payment: funderOrder() });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(live.model, 'funder');
  const r = checkBitrefillPricing({ invoiceAmount: '204.37', routerPricing: funderCreate(), live, source: funderOrder().source });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.pricing, {
    model: 'funder', original: '204.37', serviceFee: '2.05', feeBps: 100, callerPays: '206.42', callerPaysAtomicUsdc: '206420000', bridgeFee: '0.08',
  });
});

test('funder fee: 204 -> 2.04 / 206.04 too', () => {
  const o = funderOrder({ invoice: '204', fee: '2.04', total: '206.04', deposit: '206.1' });
  const live = verifyBitrefillDestination({ requested: requestedFor('204'), payment: o });
  const r = checkBitrefillPricing({ invoiceAmount: '204', routerPricing: funderCreate({ invoice: '204', fee: '2.04', total: '206.04' }), live, source: o.source });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pricing.callerPays, '206.04');
  assert.equal(r.pricing.bridgeFee, '0.06');
});

test('compatibility: a response with no fee fields is a zero-fee direct-model order', () => {
  const payment = readFixture('payment-bitrefill-unpaid-stellar.json');
  const live = verifyBitrefillDestination({ requested: { invoiceId: 'x', address: ADDR, amount: '7.9' }, payment });
  assert.equal(live.model, 'direct');
  const r = checkBitrefillPricing({ invoiceAmount: '7.9', routerPricing: readFixture('bitrefill-create-response.json'), live, source: payment.source });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.pricing, { model: 'direct', original: '7.9', serviceFee: '0', feeBps: 0, callerPays: '7.9', callerPaysAtomicUsdc: '7900000', bridgeFee: '0.031' });
  // null fee fields (a router DUPLICATE body for a row without facts) count as absent.
  const nulls = { ...readFixture('bitrefill-create-response.json'), original: null, serviceFee: null, feeBps: null, callerPays: null, callerPaysAtomicUsdc: null };
  assert.equal(checkBitrefillPricing({ invoiceAmount: '7.9', routerPricing: nulls, live, source: payment.source }).ok, true);
});

test('fee guard refuses partial, inconsistent or non-1% fee figures before any deposit', () => {
  const o = funderOrder();
  const live = verifyBitrefillDestination({ requested: requestedFor(), payment: o });
  for (const [label, patch] of [
    ['callerPays missing', { callerPays: undefined }],
    ['callerPaysAtomicUsdc missing', { callerPaysAtomicUsdc: undefined }],
    ['serviceFee missing', { serviceFee: undefined }],
    ['feeBps missing', { feeBps: undefined }],
    ['original + fee != callerPays', { callerPays: '206.43', callerPaysAtomicUsdc: '206430000' }],
    ['fee rounded to 4 dp, not the cent', { serviceFee: '2.0437', callerPays: '206.4137', callerPaysAtomicUsdc: '206413700' }],
    ['feeBps 50 (consistent figures)', { feeBps: 50, serviceFee: '1.03', callerPays: '205.4', callerPaysAtomicUsdc: '205400000' }],
    ['feeBps 0', { feeBps: 0, serviceFee: '0', callerPays: '204.37', callerPaysAtomicUsdc: '204370000' }],
    ['feeBps above the cap', { feeBps: 150 }],
    ['atomic disagrees with callerPays', { callerPaysAtomicUsdc: '206420001' }],
    ['original is not the invoice', { original: '204.36', serviceFee: '2.05', callerPays: '206.41', callerPaysAtomicUsdc: '206410000' }],
  ]) {
    const router = { ...funderCreate(), ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete router[k];
    const r = checkBitrefillPricing({ invoiceAmount: '204.37', routerPricing: router, live, source: o.source });
    assert.equal(r.ok, false, label);
    assert.equal(r.code, 'BITREFILL_FEE_MISMATCH', label);
  }
  // Short deposit.
  const short = funderOrder({ deposit: '206.41' });
  const rs = checkBitrefillPricing({ invoiceAmount: '204.37', routerPricing: funderCreate(), live, source: short.source });
  assert.equal(rs.ok, false);
});

test('fee guard refuses when the router and the live order disagree on the model', () => {
  // Router states the fee, live order is a direct-model order.
  const direct = readFixture('payment-bitrefill-unpaid-stellar.json');
  const liveDirect = verifyBitrefillDestination({ requested: { invoiceId: 'x', address: ADDR, amount: '7.9' }, payment: direct });
  const withFee = { ...readFixture('bitrefill-create-response.json'), original: '7.9', serviceFee: '0.08', feeBps: 100, callerPays: '7.98', callerPaysAtomicUsdc: '7980000' };
  assert.equal(checkBitrefillPricing({ invoiceAmount: '7.9', routerPricing: withFee, live: liveDirect, source: direct.source }).ok, false);
  // Router states no fee, live order charges one.
  const o = funderOrder();
  const liveFunder = verifyBitrefillDestination({ requested: requestedFor(), payment: o });
  const noFee = { ...funderCreate() };
  for (const k of ['original', 'serviceFee', 'feeBps', 'callerPays', 'callerPaysAtomicUsdc']) delete noFee[k];
  assert.equal(checkBitrefillPricing({ invoiceAmount: '204.37', routerPricing: noFee, live: liveFunder, source: o.source }).ok, false);
});

test('funder live order must pay the funder and freeze exactly this invoice', () => {
  const requested = requestedFor();
  for (const [label, mutate] of [
    ['payout not to the funder', (p) => { p.destination.receiverAddress = ADDR; }],
    ['frozen address differs', (p) => { p.metadata.bitrefill.address = '0x9999999999999999999999999999999999999999'; }],
    ['frozen amount differs', (p) => { p.metadata.bitrefill.amountAtomic = '204380000'; }],
    ['frozen fee rate differs', (p) => { p.metadata.bitrefill.feeBps = 50; }],
    ['frozen fee differs', (p) => { p.metadata.bitrefill.serviceFeeAtomic = '2040000'; }],
    ['frozen total differs', (p) => { p.metadata.bitrefill.callerPaysAtomic = '206410000'; }],
    ['frozen invoice id differs', (p) => { p.metadata.bitrefill.invoiceId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'; }],
    ['payout amount is not invoice + fee', (p) => { p.destination.amount = '204.37'; }],
    ['frozen facts missing', (p) => { delete p.metadata.bitrefill; }],
    ['wrong version', (p) => { p.metadata.bitrefill.v = 2; }],
  ]) {
    const p = funderOrder();
    mutate(p);
    const v = verifyBitrefillDestination({ requested, payment: p });
    assert.equal(v.ok, false, label);
    assert.equal(v.code, 'BITREFILL_ECHO_MISMATCH', label);
  }
  // Any funder marker demands the funder checks: a direct-looking order with
  // fee metadata is not accepted as direct.
  const half = clone(readFixture('payment-bitrefill-unpaid-stellar.json'));
  half.metadata = { serviceFee: '0.08' };
  assert.equal(verifyBitrefillDestination({ requested: { invoiceId: 'x', address: ADDR, amount: '7.9' }, payment: half }).ok, false);
});

test('create flow (funder): shows fee and total, accepts the lowercased UUID echo, names the late-payment rule', async () => {
  await withEnv(
    [
      ['/create-invoice', () => json(funderCreate())],
      [`/payments/${ID}`, () => json(funderOrder())],
    ],
    async (calls) => {
      const { payload, exitCode } = await capture(() => runBitrefill(FARGS()));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      // Sent as typed (the current router keys orders by it); the router's lowercase echo is accepted.
      assert.equal(calls.find((c) => c.url === `${MPP_BASE}/create-invoice`).body.bitrefill.invoiceId, UUID.toUpperCase());
      assert.equal(payload.original, '204.37');
      assert.equal(payload.serviceFee, '2.05');
      assert.equal(payload.feeBps, 100);
      assert.equal(payload.callerPays, '206.42');
      assert.equal(payload.pricing.model, 'funder');
      assert.equal(payload.pricing.bridgeFee, '0.08');
      assert.ok(payload.confirmation.warnings.some((w) => w.includes('1% Rozo service fee (2.05 USDC, total 206.42 USDC)')));
      assert.ok(payload.confirmation.warnings.some((w) => /not forwarded to Bitrefill/.test(w) && w.includes('hi@rozo.ai')));
      assert.match(payload.latePaymentPolicy, /refunded manually on request/);
      assert.doesNotMatch(payload.latePaymentPolicy, /\d+ (day|hour|business)/i, 'no refund timing promised');
      assert.equal(payload.deposit, null);
      const st = readState(ID);
      assert.deepEqual(st.bitrefill.pricing, { model: 'funder', serviceFee: '2.05', feeBps: 100, callerPays: '206.42' });
      const conf = await capture(() => runBitrefill([...FARGS(), '--confirm']));
      assert.equal(conf.exitCode, 0, JSON.stringify(conf.payload));
      assert.ok(conf.payload.deposit.receiverAddress);
    },
  );
});

test('create flow (funder): inconsistent router fee figures abort before any deposit is shown', async () => {
  for (const patch of [{ callerPays: '206.43' }, { feeBps: 99 }, { callerPaysAtomicUsdc: undefined }]) {
    const c = { ...funderCreate(), ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete c[k];
    await withEnv(
      [
        ['/create-invoice', () => json(c)],
        [`/payments/${ID}`, () => json(funderOrder())],
      ],
      async () => {
        const { payload, exitCode } = await capture(() => runBitrefill([...FARGS(), '--confirm']));
        assert.notEqual(exitCode, 0, JSON.stringify(patch));
        assert.equal(payload.error.code, 'BITREFILL_FEE_MISMATCH', JSON.stringify(patch));
        assert.equal(payload.deposit, undefined);
        assert.equal(readState(ID), null);
      },
    );
  }
});

test('create flow (current production router): no fee fields, direct order, no fee shown', async () => {
  await withEnv(
    [
      ['/create-invoice', () => json(readFixture('bitrefill-create-response.json'))],
      [`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runBitrefill(ARGS));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.equal(payload.serviceFee, '0');
      assert.equal(payload.feeBps, 0);
      assert.equal(payload.callerPays, '7.9');
      assert.equal(payload.pricing.model, 'direct');
      assert.ok(!payload.confirmation.warnings.some((w) => /service fee/.test(w)));
    },
  );
});

test('create flow (funder): DUPLICATE_INVOICE with the existing order resumes it with its fee', async () => {
  const dup = { ok: false, error: 'DUPLICATE_INVOICE', message: 'exists', invoiceId: UUID, rozoPaymentId: ID, original: '204.37', serviceFee: '2.05', feeBps: 100, callerPays: '206.42', callerPaysAtomicUsdc: '206420000' };
  await withEnv(
    [
      ['/create-invoice', () => json(dup, 409)],
      [`/payments/${ID}`, () => json(funderOrder())],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runBitrefill(FARGS()));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.equal(payload.reused, true);
      assert.equal(payload.callerPays, '206.42');
    },
  );
});

test('create flow: DUPLICATE_INVOICE under the other model (no order id) and RETRY_LATER get clear messages', async () => {
  await withEnv(
    [['/create-invoice', () => json({ ok: false, error: 'DUPLICATE_INVOICE', message: 'other model', invoiceId: UUID }, 409)]],
    async (calls) => {
      const { payload, exitCode } = await capture(() => runBitrefill(FARGS()));
      assert.notEqual(exitCode, 0);
      assert.equal(payload.error.code, 'DUPLICATE_INVOICE');
      assert.match(payload.error.message, /other Rozo checkout model/);
      assert.match(payload.error.message, /Do not pay again/);
      assert.ok(!calls.some((c) => c.url.includes('/payments/')), 'nothing resumed');
    },
  );
  await withEnv(
    [['/create-invoice', () => json({ ok: false, error: 'RETRY_LATER', message: 'claim store down' }, 503)]],
    async () => {
      const { payload } = await capture(() => runBitrefill(FARGS()));
      assert.equal(payload.error.code, 'RETRY_LATER');
      assert.match(payload.error.message, /Do not pay anything yet/);
    },
  );
});

test('create flow (funder): a native coin follows the router and its price lock', async () => {
  const native = (over = {}) => {
    const p = funderOrder();
    p.source = {
      chainId: '8453',
      tokenSymbol: 'ETH',
      tokenAddress: '0x0000000000000000000000000000000000000000',
      amount: '0.0652',
      receiverAddress: '0x2222222222222222222222222222222222222222',
      txHash: null,
      amountReceived: null,
      confirmedAt: null,
      ...over,
    };
    return p;
  };
  await withEnv(
    [
      ['/create-invoice', () => json(funderCreate())],
      [`/payments/${ID}`, () => json(native({ quoteExpiresAt: inMin(15) }))],
    ],
    async (calls) => {
      const { payload, exitCode } = await capture(() => runBitrefill(FARGS({ chain: '8453', token: 'ETH' })));
      assert.equal(exitCode, 0, JSON.stringify(payload));
      assert.deepEqual(calls.find((c) => c.url === `${MPP_BASE}/create-invoice`).body.source, { chainId: '8453', tokenSymbol: 'ETH' });
      assert.equal(payload.display.native, true);
      assert.equal(payload.pricing.bridgeFee, null, 'no bridge fee arithmetic on a coin amount');
      assert.ok(payload.expiry.quoteExpiresAt);
    },
  );
  await withEnv(
    [
      ['/create-invoice', () => json(funderCreate())],
      [`/payments/${ID}`, () => json(native())],
    ],
    async () => {
      const { payload } = await capture(() => runBitrefill([...FARGS({ chain: '8453', token: 'ETH' }), '--confirm']));
      assert.equal(payload.error.code, 'EXPIRY_UNPARSABLE', 'a native order without a price lock is refused');
      assert.equal(payload.deposit, undefined);
    },
  );
  // Current production router refuses native for Bitrefill: the refusal surfaces with a hint.
  await withEnv(
    [['/create-invoice', () => json({ ok: false, error: 'UNSUPPORTED_SOURCE', message: 'Native ETH ... not available for Bitrefill invoices' }, 400)]],
    async () => {
      const { payload } = await capture(() => runBitrefill(FARGS({ chain: '8453', token: 'ETH' })));
      assert.equal(payload.error.code, 'UNSUPPORTED_SOURCE');
      assert.match(payload.error.message, /USDC or USDT always work/);
    },
  );
});

test('ZEC is refused for Bitrefill before any request', async () => {
  await withEnv([], async (calls) => {
    const { payload } = await capture(() => runBitrefill(FARGS({ chain: '9133', token: 'ZEC' })));
    assert.equal(payload.error.code, 'ZEC_NOT_AVAILABLE');
    assert.equal(calls.length, 0);
  });
});

test('classifyStatus (funder): payout to the funder is not yet paid; the delivered stamp is', () => {
  const o = funderOrder();
  o.status = 'payment_payout_completed';
  o.source.txHash = 'abc';
  o.source.amountReceived = o.source.amount;
  o.source.confirmedAt = '2026-10-01T00:00:00Z';
  const paying = classifyStatus({ payment: o, provider: 'bitrefill' });
  assert.equal(paying.state, 'paying_merchant');
  assert.equal(paying.terminal, false);
  const done = classifyStatus({ payment: { ...o, merchantDeliveredAt: '2026-10-01T00:01:00Z' }, provider: 'bitrefill' });
  assert.equal(done.state, 'settled');
  assert.match(done.detail, /Paid to the address on the Bitrefill invoice/);
  assert.match(done.detail, /source of truth/);
  // Direct model unchanged: the payout itself pays Bitrefill.
  const direct = classifyStatus({ payment: { status: 'payment_payout_completed', source: {} }, provider: 'bitrefill' });
  assert.equal(direct.state, 'settled');
});

test('status (funder): money after the invoice expired without delivery escalates with the refund rule', async () => {
  const o = funderOrder({ expiresAt: '2020-01-01T00:00:00Z' });
  o.status = 'payment_payout_completed';
  o.source.txHash = 'abc';
  o.source.amountReceived = o.source.amount;
  o.source.confirmedAt = '2026-10-01T00:00:00Z';
  await withEnv([[`/payments/${ID}`, () => json(o)]], async () => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.provider, 'bitrefill');
    assert.equal(payload.bitrefillModel, 'funder');
    assert.equal(payload.state, 'stuck_after_payment');
    assert.equal(payload.escalate, true);
    assert.match(payload.detail, /not forwarded to Bitrefill/);
    assert.match(payload.detail, /hi@rozo\.ai/);
  });
  const fresh = funderOrder();
  fresh.status = 'payment_payout_completed';
  fresh.source.txHash = 'abc';
  fresh.source.amountReceived = fresh.source.amount;
  fresh.source.confirmedAt = '2026-10-01T00:00:00Z';
  await withEnv([[`/payments/${ID}`, () => json(fresh)]], async () => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.state, 'paying_merchant');
    assert.equal(payload.escalate, false);
  });
});

test('presend (funder): the confirmed fee must still be the live fee; a pre-fee record never pays a fee order', async () => {
  const { finalPayabilityCheck } = await import('../scripts/src/lib/presend.mjs');
  const base = {
    rozoPaymentId: ID,
    provider: 'bitrefill',
    source: { chainId: '1500', tokenSymbol: 'USDC' },
    bitrefill: { invoiceId: UUID, address: ADDR, amount: '204.37', expiresAt: inMin(20), pricing: { model: 'funder', serviceFee: '2.05', feeBps: 100, callerPays: '206.42' } },
  };
  await withEnv([[`/payments/${ID}`, () => json(funderOrder())]], async () => {
    const r = await finalPayabilityCheck({ linkId: null, chainId: '1500', state: base, rozoPaymentId: ID });
    assert.equal(r.statusNow, null);
  });
  const legacy = { ...base, bitrefill: { ...base.bitrefill, pricing: undefined } };
  await withEnv([[`/payments/${ID}`, () => json(funderOrder())]], async () => {
    await assert.rejects(
      finalPayabilityCheck({ linkId: null, chainId: '1500', state: legacy, rozoPaymentId: ID }),
      (e) => e.code === 'BITREFILL_FEE_MISMATCH',
    );
  });
  assert.deepEqual(bitrefillPricingDrift({ serviceFee: '2.05', feeBps: 100, callerPays: '206.42' }, { serviceFee: '2.05', feeBps: 100, callerPays: '206.42' }), []);
  assert.ok(bitrefillPricingDrift({ serviceFee: '2.05', feeBps: 100, callerPays: '206.42' }, { serviceFee: '2.06', feeBps: 100, callerPays: '206.43' }).length > 0);
});

// --- review round 1 -------------------------------------------------------------

test('funder facts must carry a readable expiry and a binding', () => {
  for (const mutate of [
    (p) => { delete p.metadata.bitrefill.expiresAt; },
    (p) => { p.metadata.bitrefill.expiresAt = 'soon'; },
    (p) => { delete p.metadata.bitrefill.binding; },
    (p) => { p.metadata.bitrefill.binding = 'xyz'; },
  ]) {
    const p = funderOrder();
    mutate(p);
    assert.equal(verifyBitrefillDestination({ requested: requestedFor(), payment: p }).ok, false);
  }
});

test('native price lock keeps the per-chain margin (10 min on EVM), the invoice keeps 2 min', async () => {
  const { checkBitrefillExpiry } = await import('../scripts/src/lib/bitrefill.mjs');
  const now = Date.now();
  const inv = new Date(now + 30 * 60_000).toISOString();
  assert.equal(checkBitrefillExpiry(inv, now, undefined, { quoteExpiresAt: new Date(now + 5 * 60_000).toISOString(), chainId: '8453' }).code, 'QUOTE_EXPIRY_MARGIN');
  assert.equal(checkBitrefillExpiry(inv, now, undefined, { quoteExpiresAt: new Date(now + 15 * 60_000).toISOString(), chainId: '8453' }).ok, true);
  assert.equal(checkBitrefillExpiry(inv, now, undefined, { quoteExpiresAt: new Date(now + 6 * 60_000).toISOString(), chainId: '900' }).ok, true);
  assert.equal(checkBitrefillExpiry(inv, now, undefined, { quoteExpiresAt: null, chainId: '8453' }).code, 'EXPIRY_UNPARSABLE');
  assert.equal(checkBitrefillExpiry(new Date(now + 60_000).toISOString(), now, undefined, { quoteExpiresAt: new Date(now + 20 * 60_000).toISOString(), chainId: '8453' }).code, 'INVOICE_EXPIRING');
  assert.equal(checkBitrefillExpiry(inv, now).ok, true);
});

test('status (funder): late money still bridging escalates too', async () => {
  const o = funderOrder({ expiresAt: '2020-01-01T00:00:00Z' });
  o.status = 'payment_bridging';
  o.source.txHash = 'abc';
  o.source.amountReceived = o.source.amount;
  o.source.confirmedAt = '2026-10-01T00:00:00Z';
  await withEnv([[`/payments/${ID}`, () => json(o)]], async () => {
    const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
    assert.equal(payload.state, 'stuck_after_payment');
    assert.equal(payload.escalate, true);
  });
});

test('receipt (funder): settlement evidence is the delivered stamp, never the funder payout tx', async () => {
  const { buildReceipt } = await import('../scripts/src/lib/receipt.mjs');
  const r = buildReceipt({ provider: 'bitrefill', bitrefillModel: 'funder', state: 'settled', merchantDeliveredAt: '2026-10-01T00:01:00Z', payout: { txHash: '0xfunderpayout', confirmedAt: '2026-10-01T00:00:30Z' }, authoritativeView: true });
  assert.equal(r.merchantSettlement.status, 'confirmed');
  assert.equal(r.merchantSettlement.evidence, 'rozo-delivered');
  assert.equal(r.merchantSettlement.txHash, null);
  assert.equal(r.merchantSettlement.confirmedAt, '2026-10-01T00:01:00Z');
});

test('resume (funder): binding and fee checks run on the fresh read before any deposit', async () => {
  const { run: runResume } = await import('../scripts/src/resume.mjs');
  const good = funderOrder();
  await withEnv([[`/payments/${ID}`, () => json(good)]], async () => {
    const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
    assert.equal(exitCode, 0, JSON.stringify(payload));
    assert.equal(payload.callerPays, '206.42');
    assert.equal(payload.serviceFee, '2.05');
    assert.match(payload.latePaymentPolicy, /not forwarded to Bitrefill/);
    assert.ok(payload.deposit);
  });
  for (const mutate of [
    (p) => { p.destination.amount = '204.37'; },
    (p) => { p.destination.receiverAddress = ADDR; },
    (p) => { p.metadata.bitrefill.serviceFeeAtomic = '2040000'; },
  ]) {
    const bad = funderOrder();
    mutate(bad);
    await withEnv([[`/payments/${ID}`, () => json(bad)]], async () => {
      const { payload, exitCode } = await capture(() => runResume([ID, '--confirm']));
      assert.notEqual(exitCode, 0);
      assert.equal(payload.deposit, undefined);
      assert.match(payload.error.code, /BITREFILL_(ECHO|FEE)_MISMATCH/);
    });
  }
});
