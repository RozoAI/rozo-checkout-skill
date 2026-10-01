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
const ARGS = ['--invoice-id', 'bfr-test-7f3a2', '--to', ADDR, '--amount', '7.90', '--chain', '1500', '--token', 'USDC'];

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
  const v = validateBitrefillInput({ invoiceId: 'bfr-1', address: ADDR, amount: '7.900' });
  assert.deepEqual(v, { invoiceId: 'bfr-1', address: ADDR, amount: '7.9', expiresAt: null });
});

test('bad address, amount and id are refused locally', () => {
  const base = { invoiceId: 'bfr-1', address: ADDR, amount: '7.90' };
  for (const [patch, code] of [
    [{ address: '0x123' }, 'INVALID_ADDRESS'],
    [{ address: 'GCEXAMPLE' }, 'INVALID_ADDRESS'],
    [{ amount: '0' }, 'INVALID_AMOUNT'],
    [{ amount: '-1' }, 'INVALID_AMOUNT'],
    [{ amount: '1.1234567' }, 'INVALID_AMOUNT'],
    [{ amount: '1e3' }, 'INVALID_AMOUNT'],
    [{ invoiceId: '' }, 'BAD_BITREFILL_INVOICE'],
    [{ invoiceId: 'a b' }, 'BAD_BITREFILL_INVOICE'],
  ]) {
    assert.throws(() => validateBitrefillInput({ ...base, ...patch }), (e) => e.code === code, JSON.stringify(patch));
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
      assert.deepEqual(post.body.bitrefill, { invoiceId: 'bfr-test-7f3a2', address: ADDR, amount: '7.9' });
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
  for (const status of ['payment_payout_completed', 'payment_completed']) {
    const v = classifyStatus({ payment: { status, source: {} }, provider: 'bitrefill' });
    assert.equal(v.state, 'settled');
    assert.equal(v.terminal, true);
  }
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
  done.status = 'payment_completed';
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
  assert.equal(o.command, 'pay');
  assert.equal(o.target, null);
  assert.deepEqual(o.bitrefill, { invoiceId: 'bfr-1', address: ADDR, amount: '7.90', expiresAt: '2099-01-01T00:00:00Z' });
  assert.deepEqual(o.source, { chainId: '1500', tokenSymbol: 'USDC' });
  const w = parseCliArgs(['pay', '--bitrefill-invoice', 'bfr-1', '--to', ADDR, '--amount', '1', '--with', 'usdt-solana']);
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
    bitrefill: { expiresAt: '2099-01-01T00:00:00.000Z' },
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
  const expiring = { ...state, bitrefill: { expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  await withEnv([[`/payments/${ID}`, () => json(readFixture('payment-bitrefill-unpaid-stellar.json'))]], async () => {
    await assert.rejects(
      finalPayabilityCheck({ linkId: null, chainId: '1500', state: expiring, rozoPaymentId: ID }),
      (e) => /EXPIR/.test(e.code),
    );
  });
});
