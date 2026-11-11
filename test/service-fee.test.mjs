/**
 * Rozo service fee on Coinbase invoices.
 *
 * The router charges a service fee on top of the invoice (1% at the time of
 * writing): quote and create return original, serviceFee, callerPays and
 * feeBps, with callerPays = original + serviceFee. The CLI must accept that
 * shape, and nothing looser: the fee has to be stated explicitly, at or under
 * MAX_SERVICE_FEE_BPS, equal to the fee its rate produces, and identical
 * between quote and create. Any other amount is refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkPricing,
  checkQuotePricing,
  verifyCreateAgainstQuote,
  serviceFeeAtomicFor,
  MAX_SERVICE_FEE_BPS,
} from '../scripts/src/lib/guards.mjs';
import { snapshotFromQuote } from '../scripts/src/lib/api.mjs';
import { capture } from '../scripts/src/lib/output.mjs';
import { run as runCreateOrder } from '../scripts/src/create-order.mjs';
import { run as runQuote } from '../scripts/src/quote.mjs';
import { readFixture, clone } from './helpers.mjs';

process.env.ROZO_CHECKOUT_ANON_ID = 'off';

const LINK = 'https://payments.coinbase.com/payment-links/pl_01FEETESTFEETESTFEETE';
const LINK_ID = 'pl_01FEETESTFEETESTFEETE';
const ID = '44444444-5555-4666-8777-888888888888';
const REQUESTED = { chainId: '900', tokenSymbol: 'USDT' };

const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString();

// Shape of the live router response on 2026-11-11 for a $10.50 OpenRouter
// invoice: the nested upstream quote.callerPays carries no fee, the top-level
// pricing block does.
function quoteBody(over = {}) {
  return {
    linkId: LINK_ID,
    protocolVersion: 'v1',
    merchant: 'OpenRouter, Inc.',
    invoice: { amount: '10.50', fiat: { amount: '10.50', currency: 'USD' } },
    original: '10.5',
    serviceFee: '0.11',
    callerPays: '10.61',
    feeBps: 100,
    pricingVersion: 'checkout-web-fee-v3',
    quote: { callerPays: '10.500000', feeBps: 100 },
    coinbasePayment: { id: LINK_ID, status: 'active', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(24 * 60) },
    quoteReceipt: 'receipt',
    supportedSources: { 900: ['USDC', 'USDT'] },
    ...over,
  };
}

function createBody(over = {}) {
  return {
    ok: true,
    reused: false,
    linkId: LINK_ID,
    merchant: 'OpenRouter, Inc.',
    original: '10.5',
    serviceFee: '0.11',
    callerPays: '10.61',
    feeBps: 100,
    pricingVersion: 'checkout-web-fee-v3',
    discount: '0',
    rozoPaymentId: ID,
    expiresAt: inMin(12 * 60),
    source: { chainId: '900', tokenSymbol: 'USDT' },
    ...over,
  };
}

function payment() {
  const p = clone(readFixture('payment-unpaid-solana.json'));
  p.id = ID;
  p.orderId = LINK_ID;
  p.expiresAt = inMin(12 * 60);
  p.source.amount = '10.61';
  return p;
}

const invoiceStatusBody = () => ({
  ok: true,
  pl_id: LINK_ID,
  coinbase: { protocolVersion: 'v1', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(24 * 60), settled: false },
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withHttp(routes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-fee-'));
  const prevDir = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET' });
    for (const [match, respond] of routes) if (u.includes(match)) return respond();
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

// ---------------------------------------------------------------------------
// pricing arithmetic
// ---------------------------------------------------------------------------

test('the cap is 100 bps and the fee rounds up to a whole cent, like the router', () => {
  assert.equal(MAX_SERVICE_FEE_BPS, 100);
  assert.equal(serviceFeeAtomicFor(10_500_000n, 100), 110_000n); // $10.50 -> $0.11 (0.105 up)
  assert.equal(serviceFeeAtomicFor(1_050_000n, 100), 20_000n); // $1.05 -> $0.02 (0.0105 up)
  assert.equal(serviceFeeAtomicFor(525_000_000n, 100), 5_250_000n); // $525 -> $5.25
  assert.equal(serviceFeeAtomicFor(10_000_000n, 0), 0n);
});

test('checkPricing: the live fee shape passes and is normalized', () => {
  const r = checkPricing({ original: '10.5', serviceFee: '0.11', callerPays: '10.61', feeBps: 100, discount: '0' });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.pricing, { original: '10.5', serviceFee: '0.11', callerPays: '10.61', feeBps: 100 });
  // feeBps as a digit string is the same rate.
  assert.equal(checkPricing({ original: '10.5', serviceFee: '0.11', callerPays: '10.61', feeBps: '100' }).ok, true);
});

test('checkPricing: no fee fields means zero fee, and then callerPays must equal original', () => {
  const ok = checkPricing({ original: '5.00', callerPays: '5.000000' });
  assert.equal(ok.ok, true);
  assert.equal(ok.pricing.serviceFee, '0');
  assert.equal(ok.pricing.feeBps, 0);
  // An unexplained surcharge is refused.
  const r = checkPricing({ original: '10.5', callerPays: '10.61' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PRICING_VIOLATION');
  assert.equal(r.field, 'callerPays');
});

test('checkPricing: every mismatched or unstated amount is refused', () => {
  const base = { original: '10.5', serviceFee: '0.11', callerPays: '10.61', feeBps: 100 };
  const cases = [
    [{ ...base, feeBps: undefined }, 'feeBps'], // fee without its rate
    [{ ...base, feeBps: null }, 'feeBps'],
    [{ ...base, serviceFee: undefined }, 'serviceFee'], // rate without the fee
    [{ ...base, serviceFee: '' }, 'serviceFee'],
    [{ ...base, feeBps: 101, serviceFee: '0.11' }, 'feeBps'], // over the cap
    [{ ...base, feeBps: 200, serviceFee: '0.21', callerPays: '10.71' }, 'feeBps'],
    [{ ...base, feeBps: -1 }, 'feeBps'],
    [{ ...base, feeBps: 1.5 }, 'feeBps'],
    [{ ...base, feeBps: '1e2' }, 'feeBps'],
    [{ ...base, serviceFee: '0.12', callerPays: '10.62' }, 'serviceFee'], // not what 100 bps produces
    [{ ...base, serviceFee: '0.10', callerPays: '10.60' }, 'serviceFee'],
    [{ ...base, feeBps: 50 }, 'serviceFee'], // rate and fee disagree
    [{ ...base, callerPays: '10.62' }, 'callerPays'], // total is not invoice + fee
    [{ ...base, callerPays: '10.60' }, 'callerPays'],
    [{ ...base, callerPays: '10.5' }, 'callerPays'],
    [{ ...base, original: undefined }, 'original'],
    [{ ...base, callerPays: null }, 'callerPays'],
    [{ ...base, callerPays: '10.61 USD' }, 'callerPays'],
    [{ ...base, serviceFee: '-0.11' }, 'serviceFee'],
    [{ ...base, callerPays: '10.6100001' }, 'callerPays'], // beyond USDC precision
  ];
  for (const [input, field] of cases) {
    const r = checkPricing(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.code, 'PRICING_VIOLATION', JSON.stringify(input));
    assert.equal(r.field, field, JSON.stringify(input));
  }
  // A discount is still its own violation.
  assert.equal(checkPricing({ ...base, discount: '0.5' }).code, 'NO_DISCOUNT_VIOLATION');
});

test('snapshotFromQuote binds the top-level fee-inclusive total, not the nested upstream amount', () => {
  const snap = snapshotFromQuote(quoteBody());
  assert.equal(snap.callerPays, '10.61');
  assert.equal(snap.serviceFee, '0.11');
  assert.equal(snap.feeBps, 100);
  assert.equal(snap.original, '10.50');
  assert.equal(checkQuotePricing(snap).ok, true);
  // A router that states no pricing block falls back to the nested amount,
  // and then no fee can be accepted.
  const legacy = snapshotFromQuote({ ...quoteBody(), original: undefined, serviceFee: undefined, callerPays: undefined, feeBps: undefined });
  assert.equal(legacy.callerPays, '10.500000');
  assert.equal(checkQuotePricing(legacy).pricing.serviceFee, '0');
  // The router's own original must agree with the invoice amount.
  const mismatch = snapshotFromQuote(quoteBody({ original: '10.4', serviceFee: '0.11', callerPays: '10.51' }));
  assert.equal(checkQuotePricing(mismatch).code, 'PRICING_VIOLATION');
});

test('post-create: the fee-inclusive create matches the fee-inclusive quote', () => {
  const snapshot = snapshotFromQuote(quoteBody());
  const r = verifyCreateAgainstQuote({ snapshot, created: createBody(), requested: REQUESTED });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('post-create: any fee difference between quote and create stops the run', () => {
  const snapshot = snapshotFromQuote(quoteBody());
  // A fee the quote did not show.
  const zeroFeeQuote = snapshotFromQuote(quoteBody({ serviceFee: '0', feeBps: 0, callerPays: '10.5' }));
  const a = verifyCreateAgainstQuote({ snapshot: zeroFeeQuote, created: createBody(), requested: REQUESTED });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'CREATE_DRIFT');
  // Create drops its fee fields but keeps the higher total.
  const b = verifyCreateAgainstQuote({
    snapshot,
    created: createBody({ serviceFee: undefined, feeBps: undefined }),
    requested: REQUESTED,
  });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'PRICING_VIOLATION');
  // Create states a different rate for the same total (cannot add up).
  const c = verifyCreateAgainstQuote({ snapshot, created: createBody({ feeBps: 99 }), requested: REQUESTED });
  assert.equal(c.ok, false);
  // Quote with no pricing block (old router) and a fee-inclusive create.
  const legacy = snapshotFromQuote({ ...quoteBody(), original: undefined, serviceFee: undefined, callerPays: undefined, feeBps: undefined });
  const d = verifyCreateAgainstQuote({ snapshot: legacy, created: createBody(), requested: REQUESTED });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'CREATE_DRIFT');
  // An over-cap fee that adds up is still refused, on the quote side first.
  const greedy = snapshotFromQuote(quoteBody({ serviceFee: '0.21', feeBps: 200, callerPays: '10.71' }));
  const e = verifyCreateAgainstQuote({
    snapshot: greedy,
    created: createBody({ serviceFee: '0.21', feeBps: 200, callerPays: '10.71' }),
    requested: REQUESTED,
  });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'PRICING_VIOLATION');
});

// ---------------------------------------------------------------------------
// end to end with stubbed HTTP
// ---------------------------------------------------------------------------

test('quote shows invoice, fee and total; a quote that does not add up is an error', async () => {
  await withHttp([['/quote-invoice', () => json(quoteBody())]], async () => {
    const { payload, exitCode } = await capture(() => runQuote(['--url', LINK]));
    assert.equal(exitCode, 0, JSON.stringify(payload.error));
    assert.equal(payload.invoice.amount, '10.50');
    assert.equal(payload.serviceFee, '0.11');
    assert.equal(payload.feeBps, 100);
    assert.equal(payload.callerPays, '10.61');
    assert.equal(payload.warnings, undefined);
  });
  await withHttp([['/quote-invoice', () => json(quoteBody({ callerPays: '10.71' }))]], async () => {
    const { payload, exitCode } = await capture(() => runQuote(['--url', LINK]));
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'PRICING_VIOLATION');
  });
});

test('create: the live fee shape yields a verified order that shows invoice, fee and total', async () => {
  const p = payment();
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody())],
      [`/payments/${ID}`, () => json(p)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async () => {
      const { payload, exitCode } = await capture(() =>
        runCreateOrder(['--url', LINK, '--chain', '900', '--token', 'USDT']),
      );
      assert.equal(exitCode, 0, JSON.stringify(payload.error));
      assert.equal(payload.success, true);
      assert.equal(payload.invoice.amount, '10.5');
      assert.equal(payload.serviceFee, '0.11');
      assert.equal(payload.feeBps, 100);
      assert.equal(payload.callerPays, '10.61');
    },
  );
});

test('create: a quote whose fee is over the cap creates nothing', async () => {
  await withHttp(
    [['/quote-invoice', () => json(quoteBody({ serviceFee: '0.21', feeBps: 200, callerPays: '10.71' }))]],
    async (calls) => {
      const { payload, exitCode } = await capture(() =>
        runCreateOrder(['--url', LINK, '--chain', '900', '--token', 'USDT']),
      );
      assert.equal(exitCode, 1);
      assert.equal(payload.step, 'quote-pricing');
      assert.equal(payload.error.code, 'PRICING_VIOLATION');
      assert.ok(!calls.some((c) => c.url.includes('/create-invoice')), 'nothing was created');
    },
  );
});

test('create: a create response that charges more than the quote is refused, deposit withheld', async () => {
  const p = payment();
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody({ serviceFee: '0.12', callerPays: '10.62' }))],
      [`/payments/${ID}`, () => json(p)],
      ['/invoice-status', () => json(invoiceStatusBody())],
    ],
    async () => {
      const { payload, exitCode } = await capture(() =>
        runCreateOrder(['--url', LINK, '--chain', '900', '--token', 'USDT', '--confirm']),
      );
      assert.equal(exitCode, 1);
      assert.equal(payload.step, 'verify-create');
      assert.equal(payload.deposit, undefined);
    },
  );
});
