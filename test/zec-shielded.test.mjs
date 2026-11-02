/**
 * Shielded ZEC (Beta): the CLI creates the order through the router and shows
 * the Unified Address, the exact amount and the ZIP-321 payment URI; it never
 * holds a Zcash wallet. These tests pin the offer gate, the request the router
 * receives (beta opt-in and source.shielded), what the payer is shown, the
 * mode-mismatch and refusal mapping, and the status view. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isZecSource,
  isUnifiedAddress,
  zecShieldedOfferFor,
  zecRequiredConfirmations,
  parsePaymentUri,
  validateShieldedDeposit,
  zecStatusOf,
  ZEC_BETA_PARAM,
  ZEC_SHIELDED_MAX_USD,
} from '../scripts/src/lib/zec.mjs';
import { reuseGuard, validateDepositInstructions, classifyStatus } from '../scripts/src/lib/guards.mjs';
import { chainFamily, chainName, decimalsFor, isSupportedSource, isNativeSource } from '../scripts/src/lib/amounts.mjs';
import { parseCliArgs, resolvePreset, pickerOptionsFor } from '../scripts/src/lib/cli-args.mjs';
import { withBeta } from '../scripts/src/lib/api.mjs';
import { MINUTE } from '../scripts/src/lib/expiry.mjs';
import { capture } from '../scripts/src/lib/output.mjs';
import { run as runCreateOrder } from '../scripts/src/create-order.mjs';
import { run as runQuote } from '../scripts/src/quote.mjs';
import { run as runStatus } from '../scripts/src/status.mjs';

process.env.ROZO_CHECKOUT_ANON_ID = 'off';

const inMin = (m) => new Date(Date.now() + m * MINUTE).toISOString();
// Shape-valid mainnet Unified Address (bech32m charset, 190 data chars).
const UA = 'u1' + 'ajysyeczq8hlm3x9pr5gtgvtnx0fh7ewkhnpu3qeurcwvm4ls8ye2n4vwz2cx7h7nw0ut3ar8q0p9pwcvauc5vquvxt9pxx73xhhwm2qxv5pzmyxexp3c4sd5qc2crag4w2lugs4ehtxh2zdcqm88lmvxcmqlrmjmtmyedut9kjk36fxv2j8dp3qq4cqfs0ad2';
const T1 = 't1Y5cip8498GcPmpGzdjFjywVGMK1etXfnh';
const AMOUNT = '0.00851258';
const URI = `zcash:${UA}?amount=${AMOUNT}&memo=NGJhMjA5YWUtNGMyZC00NzIxLWFmZDktNTE3ODJmMDU2ZGUy`;
const LINK = 'https://payments.coinbase.com/payment-sessions/paymentSession_0ef210bc-06a3-4e8a-ab34-b26070bdf056';
const LINK_ID = 'paymentSession_0ef210bc-06a3-4e8a-ab34-b26070bdf056';
const ID = '4ba209ae-4c2d-4721-afd9-51782f056de2';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ZEC_META = { refund_address_required: false, beta: true, address_single_use: true, confirmations: { under110: 1, from110: 2 }, shieldedAvailable: true };

function quoteBody({ callerPays = '10.61', supportedSources = { 9133: ['ZEC'], 8453: ['USDC'] }, sourceMeta = { 'ZEC@9133': ZEC_META } } = {}) {
  return {
    linkId: LINK_ID,
    protocolVersion: 'v3',
    merchant: 'OpenRouter, Inc',
    invoice: { amount: callerPays, fiat: { amount: callerPays, currency: 'USD' } },
    quote: { callerPays },
    coinbasePayment: { id: LINK_ID, status: 'PAYMENT_SESSION_STATUS_CREATED', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(24 * 60) },
    quoteReceipt: 'receipt',
    supportedSources,
    sourceMeta,
  };
}

function zecPayment({ receive = 'shielded', payinState = 'awaiting', confirmations = 0, requiredConfirmations = 1, quoteExpiresAt = inMin(30), receiverAddress = UA, paymentUri = URI, amountReceived = null } = {}) {
  return {
    id: ID,
    status: 'payment_unpaid',
    expiresAt: inMin(12 * 60),
    source: {
      chainId: '9133', tokenSymbol: 'ZEC', amount: AMOUNT, receiverAddress, senderAddress: null, txHash: null, amountReceived, confirmedAt: null,
      ...(receive === 'shielded' ? { paymentUri } : {}),
      zec: { rail: 'zec_custody', receive, payinState, confirmations, requiredConfirmations, requiredZat: '851258', receivedZat: '0', quoteExpiresAt },
    },
    destination: { chainId: '8453', tokenSymbol: 'USDC', amount: '10.61' },
  };
}

function createBody(payment, extra = {}) {
  return {
    ok: true,
    reused: false,
    linkId: LINK_ID,
    merchant: 'OpenRouter, Inc',
    original: '10.61',
    callerPays: '10.61',
    discount: '0',
    rozoPaymentId: ID,
    expiresAt: payment.expiresAt,
    quoteExpiresAt: payment.source.zec.quoteExpiresAt,
    source: { chainId: '9133', tokenSymbol: 'ZEC', zec: { receive: payment.source.zec.receive }, ...(payment.source.paymentUri ? { paymentUri: payment.source.paymentUri } : {}) },
    ...extra,
  };
}

const invoiceStatusBody = (payment) => ({
  ok: true,
  pl_id: LINK_ID,
  protocolVersion: 'v3',
  coinbase: { protocolVersion: 'v3', status: 'PAYMENT_SESSION_STATUS_CREATED', usageCount: 0, maxUsage: 1, preApprovalExpiry: inMin(24 * 60), settled: false },
  ...(payment ? { rozo_payment_id: ID, rozoPayment: payment } : {}),
});

async function withHttp(routes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-zec-'));
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

const createArgs = (...extra) => ['--url', LINK, '--chain', '9133', '--token', 'ZEC', '--shielded', ...extra];

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('ZEC is a supported, non-native source on chain 9133 with 8 decimals and its own family', () => {
  assert.equal(isSupportedSource('9133', 'ZEC'), true);
  assert.equal(isNativeSource('9133', 'ZEC'), false);
  assert.equal(isZecSource('9133', 'zec'), true);
  assert.equal(isZecSource('8453', 'ZEC'), false);
  assert.equal(decimalsFor('9133', 'ZEC'), 8);
  assert.equal(chainName('9133'), 'Zcash');
  assert.equal(chainFamily('9133'), 'zcash');
  assert.equal(zecRequiredConfirmations(10.61), 1);
  assert.equal(zecRequiredConfirmations(110), 2);
});

test('offer gate: needs ZEC listed, shieldedAvailable, and an invoice inside the beta bounds', () => {
  const ok = zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: { 'ZEC@9133': ZEC_META }, callerPaysUsd: '10.61' });
  assert.deepEqual([ok.ok, ok.requiredConfirmations], [true, 1]);
  assert.equal(zecShieldedOfferFor({ supportedSources: { 8453: ['USDC'] }, sourceMeta: { 'ZEC@9133': ZEC_META }, callerPaysUsd: '10' }).code, 'ZEC_NOT_OFFERED');
  assert.equal(zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: { 'ZEC@9133': { ...ZEC_META, shieldedAvailable: false } }, callerPaysUsd: '10' }).code, 'ZEC_SHIELDED_NOT_AVAILABLE');
  assert.equal(zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: {}, callerPaysUsd: '10' }).code, 'ZEC_SHIELDED_NOT_AVAILABLE');
  // snake_case spelling is accepted too
  assert.equal(zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: { 'ZEC@9133': { shielded_available: true } }, callerPaysUsd: '10' }).ok, true);
  assert.equal(zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: { 'ZEC@9133': ZEC_META }, callerPaysUsd: String(ZEC_SHIELDED_MAX_USD + 0.01) }).code, 'ZEC_AMOUNT_TOO_HIGH');
  assert.equal(zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: { 'ZEC@9133': ZEC_META }, callerPaysUsd: '4.99' }).code, 'ZEC_AMOUNT_TOO_LOW');
  assert.equal(zecShieldedOfferFor({ supportedSources: { 9133: ['ZEC'] }, sourceMeta: { 'ZEC@9133': ZEC_META }, callerPaysUsd: null }).code, 'ZEC_AMOUNT_UNKNOWN');
});

test('payment URI: one payment, amount and memo only, exact address and amount', () => {
  assert.deepEqual(parsePaymentUri(URI), { address: UA, amount: AMOUNT, memo: 'NGJhMjA5YWUtNGMyZC00NzIxLWFmZDktNTE3ODJmMDU2ZGUy' });
  assert.equal(parsePaymentUri(`zcash:${UA}?amount=${AMOUNT}`).memo, null);
  assert.equal(parsePaymentUri(`zcash:${UA}?amount=${AMOUNT}&amount=1`), null);
  assert.equal(parsePaymentUri(`zcash:${UA}?amount=${AMOUNT}&label=x`), null);
  assert.equal(parsePaymentUri(`zcash:${UA}?amount.1=${AMOUNT}`), null);
  assert.equal(parsePaymentUri(`zcash:${UA}?memo=abc`), null);
  assert.equal(parsePaymentUri(`bitcoin:${UA}?amount=1`), null);
  assert.equal(isUnifiedAddress(UA), true);
  assert.equal(isUnifiedAddress(T1), false);
  assert.equal(isUnifiedAddress('u1' + 'b'.repeat(150)), false); // 'b' is outside the bech32m charset

  const ok = validateShieldedDeposit({ receiverAddress: UA, amount: AMOUNT, paymentUri: URI });
  assert.equal(ok.ok, true);
  assert.equal(validateShieldedDeposit({ receiverAddress: UA, amount: '0.0085125800', paymentUri: URI }).ok, true);
  assert.equal(validateShieldedDeposit({ receiverAddress: T1, amount: AMOUNT, paymentUri: URI }).code, 'ZEC_ADDRESS_INVALID');
  assert.equal(validateShieldedDeposit({ receiverAddress: UA, amount: AMOUNT }).code, 'ZEC_PAYMENT_URI_MISSING');
  assert.equal(validateShieldedDeposit({ receiverAddress: UA, amount: '0.009', paymentUri: URI }).code, 'ZEC_PAYMENT_URI_MISMATCH');
  assert.equal(validateShieldedDeposit({ receiverAddress: UA, amount: AMOUNT, paymentUri: `zcash:${UA}?amount=${AMOUNT}&label=x` }).code, 'ZEC_PAYMENT_URI_INVALID');
});

test('zecStatusOf validates the custody block field by field', () => {
  const z = zecStatusOf(zecPayment({ payinState: 'seen', confirmations: 0 }).source);
  assert.deepEqual([z.receive, z.payinState, z.confirmations, z.requiredConfirmations], ['shielded', 'seen', 0, 1]);
  assert.equal(zecStatusOf({ zec: { receive: 'other', payinState: 'nope', confirmations: -1, requiredConfirmations: 3 } }).receive, null);
  assert.equal(zecStatusOf({}), null);
});

test('deposit validation and reuse guard understand shielded orders', () => {
  const ok = validateDepositInstructions(zecPayment().source);
  assert.equal(ok.ok, true);
  assert.equal(ok.payTo, UA);
  assert.equal(ok.paymentUri, URI);
  assert.equal(validateDepositInstructions(zecPayment({ paymentUri: null }).source).code, 'ZEC_PAYMENT_URI_MISSING');

  const want = { chainId: '9133', tokenSymbol: 'ZEC', shielded: true };
  assert.equal(reuseGuard({ payment: zecPayment(), requested: want }).ok, true);
  // a transparent order on the same link is not what was asked for
  assert.equal(reuseGuard({ payment: zecPayment({ receive: 'transparent', receiverAddress: T1 }), requested: want }).code, 'ZEC_RECEIVE_MODE_MISMATCH');
  // and the other way round
  assert.equal(reuseGuard({ payment: zecPayment(), requested: { chainId: '9133', tokenSymbol: 'ZEC' } }).code, 'ZEC_RECEIVE_MODE_MISMATCH');
  // an expired, unfunded quote is not payable
  assert.equal(reuseGuard({ payment: zecPayment({ payinState: 'expired' }), requested: want }).code, 'ZEC_QUOTE_EXPIRED');
  // money outranks everything, and for ZEC a sighting in source.zec IS money
  assert.equal(reuseGuard({ payment: zecPayment({ amountReceived: AMOUNT }), requested: want }).code, 'ORDER_ALREADY_FUNDED');
  for (const payinState of ['seen', 'confirming', 'eligible']) {
    const g = reuseGuard({ payment: zecPayment({ payinState }), requested: want });
    assert.equal(g.code, 'ORDER_ALREADY_FUNDED', payinState);
    assert.equal(g.moneyDetected, true);
  }
  const zatOnly = zecPayment();
  zatOnly.source.zec.receivedZat = '1';
  assert.equal(reuseGuard({ payment: zatOnly, requested: want }).moneyDetected, true);
  // an unreadable custody block fails closed
  const noState = zecPayment();
  delete noState.source.zec.payinState;
  assert.equal(reuseGuard({ payment: noState, requested: want }).code, 'ORDER_ALREADY_FUNDED');
});

test('cli args: --with zec needs --shielded; --shielded is ZEC only; --send is refused; the picker row is offered per invoice', () => {
  assert.deepEqual(resolvePreset('zec'), { chainId: '9133', tokenSymbol: 'ZEC' });
  assert.deepEqual(resolvePreset('zec-zcash'), { chainId: '9133', tokenSymbol: 'ZEC' });
  const ok = parseCliArgs(['pay', LINK, '--with', 'zec', '--shielded']);
  assert.deepEqual(ok.source, { chainId: '9133', tokenSymbol: 'ZEC', shielded: true });
  assert.equal(ok.shielded, true);
  assert.throws(() => parseCliArgs(['pay', LINK, '--with', 'zec']), (e) => e.code === 'ZEC_SHIELDED_REQUIRED');
  assert.throws(() => parseCliArgs(['pay', LINK, '--with', 'usdc-base', '--shielded']), (e) => e.code === 'CONFLICTING_FLAGS');
  assert.throws(() => parseCliArgs(['pay', LINK, '--with', 'zec', '--shielded', '--send']), (e) => e.code === 'CONFLICTING_FLAGS');
  assert.equal(parseCliArgs(['pay', LINK, '--with', 'usdc-base']).shielded, false);
  assert.ok(!pickerOptionsFor(() => false).some((o) => o.chainId === '9133'));
  assert.ok(pickerOptionsFor((c) => c === '9133').some((o) => o.chainId === '9133' && o.label === 'ZEC from a shielded balance'));
  assert.equal(withBeta('https://x.test/quote-invoice', ZEC_BETA_PARAM), 'https://x.test/quote-invoice?beta=zec%2Czec_shielded');
  assert.equal(withBeta('https://x.test/quote-invoice', undefined), 'https://x.test/quote-invoice');
});

// ---------------------------------------------------------------------------
// end-to-end with stubbed HTTP
// ---------------------------------------------------------------------------

test('quote reports shielded ZEC availability and sends the beta opt-in', async () => {
  await withHttp([['/quote-invoice', () => json(quoteBody())]], async (calls) => {
    const { payload, exitCode } = await capture(() => runQuote(['--url', LINK]));
    assert.equal(exitCode, 0, JSON.stringify(payload));
    assert.equal(payload.zecShielded.offered, true);
    assert.equal(payload.zecShielded.requiredConfirmations, 1);
    assert.ok(calls[0].url.includes('beta=zec%2Czec_shielded'));
  });
  await withHttp([['/quote-invoice', () => json(quoteBody({ sourceMeta: {} }))]], async () => {
    const { payload, exitCode } = await capture(() => runQuote(['--url', LINK, '--chain', '9133', '--token', 'ZEC']));
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'ZEC_SHIELDED_NOT_AVAILABLE');
  });
});

test('create: the router gets the beta opt-in and source.shielded; the payer gets the UA, the amount and the URI', async () => {
  const payment = zecPayment();
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(payment))],
      [`/payments/${ID}`, () => json(payment)],
      ['/invoice-status', () => json(invoiceStatusBody(payment))],
    ],
    async (calls) => {
      const first = await capture(() => runCreateOrder(createArgs()));
      assert.equal(first.exitCode, 0, JSON.stringify(first.payload));
      const create = calls.find((c) => c.url.includes('/create-invoice'));
      assert.ok(create.url.includes('beta=zec%2Czec_shielded'), 'create carries the opt-in');
      assert.deepEqual(create.body.source, { chainId: '9133', tokenSymbol: 'ZEC', shielded: true });
      assert.equal(create.body.refund_address, undefined);
      assert.ok(calls.find((c) => c.url.includes('/quote-invoice')).url.includes('beta=zec%2Czec_shielded'));
      // withheld until --confirm; the masked summary already says shielded
      assert.equal(first.payload.deposit, null);
      assert.equal(first.payload.display.shielded, true);
      assert.equal(first.payload.display.payToMasked, `${UA.slice(0, 6)}...${UA.slice(-4)}`);
      assert.ok(!JSON.stringify(first.payload).includes(URI), 'the URI is withheld before confirm');

      const conf = await capture(() => runCreateOrder(createArgs('--confirm')));
      assert.equal(conf.exitCode, 0, JSON.stringify(conf.payload));
      const d = conf.payload.deposit;
      assert.equal(d.shielded, true);
      assert.equal(d.receiverAddress, UA);
      assert.equal(d.amount, AMOUNT);
      assert.equal(d.paymentUri, URI);
      assert.equal(d.exactOut, true);
      assert.equal(d.requiredConfirmations, 1);
      assert.equal(d.quoteExpiresAt, payment.source.zec.quoteExpiresAt);
      assert.equal(d.lnInvoice, null);
      assert.ok(conf.payload.confirmation.warnings.some((w) => /one transaction/i.test(w)));
      assert.ok(conf.payload.nextStep.modeB.includes('paymentUri'));
    },
  );
});

test('create: no --shielded with ZEC is refused before any call; a transparent answer to a shielded request is a mode mismatch', async () => {
  await withHttp([], async (calls) => {
    const { payload, exitCode } = await capture(() => runCreateOrder(['--url', LINK, '--chain', '9133', '--token', 'ZEC']));
    assert.equal(exitCode, 1);
    assert.equal(payload.error.code, 'ZEC_SHIELDED_REQUIRED');
    assert.equal(calls.length, 0);
  });
  // the router answers the mode clash with the existing order plus a flag
  const existing = zecPayment({ receive: 'transparent', receiverAddress: T1 });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(existing, { reused: true, sourceMismatch: true, sourceMismatchCode: 'ZEC_RECEIVE_MODE_MISMATCH' }))],
      [`/payments/${ID}`, () => json(existing)],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder(createArgs()));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'ZEC_RECEIVE_MODE_MISMATCH');
      assert.equal(payload.existingOrder.receive, 'transparent');
      assert.equal(payload.nextAction.canCreateOrder, false);
    },
  );
  // and without the flag, the live read catches it
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(existing, { reused: true }))],
      [`/payments/${ID}`, () => json(existing)],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder(createArgs()));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'ZEC_RECEIVE_MODE_MISMATCH');
    },
  );
});

test('create: router refusals surface by code; an offer the quote does not make is refused before create; a bad URI is never shown', async () => {
  for (const code of ['ZEC_SHIELDED_NOT_ENABLED', 'AMOUNT_BELOW_MIN', 'ZEC_SHIELDED_REFUND_ADDRESS_NOT_APPLICABLE']) {
    await withHttp(
      [
        ['/quote-invoice', () => json(quoteBody())],
        ['/create-invoice', () => json({ error: { code, message: 'refused' } }, 400)],
      ],
      async () => {
        const { payload, exitCode } = await capture(() => runCreateOrder(createArgs()));
        assert.equal(exitCode, 1);
        assert.equal(payload.error.code, code);
      },
    );
  }
  await withHttp([['/quote-invoice', () => json(quoteBody({ callerPays: '1500' }))]], async (calls) => {
    const { payload } = await capture(() => runCreateOrder(createArgs()));
    assert.equal(payload.error.code, 'ZEC_AMOUNT_TOO_HIGH');
    assert.ok(!calls.some((c) => c.url.includes('/create-invoice')));
  });
  const bad = zecPayment({ paymentUri: `zcash:${UA}?amount=0.009` });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(bad))],
      [`/payments/${ID}`, () => json(bad)],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder(createArgs('--confirm')));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'ZEC_PAYMENT_URI_MISMATCH');
      assert.ok(!JSON.stringify(payload).includes('amount=0.009'));
    },
  );
  // a shielded order whose pay-in was already seen is never shown as payable again
  const seen = zecPayment({ payinState: 'seen' });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json(createBody(seen, { reused: true }))],
      [`/payments/${ID}`, () => json(seen)],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder(createArgs('--confirm')));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'ORDER_ALREADY_FUNDED');
      assert.equal(payload.moneyDetected, true);
      assert.ok(!JSON.stringify(payload).includes(URI));
    },
  );
  // a missing LIVE price lock is a refusal even when the create response carried one
  const noLock = zecPayment({ quoteExpiresAt: null });
  await withHttp(
    [
      ['/quote-invoice', () => json(quoteBody())],
      ['/create-invoice', () => json({ ...createBody(noLock), quoteExpiresAt: inMin(30) })],
      [`/payments/${ID}`, () => json(noLock)],
    ],
    async () => {
      const { payload, exitCode } = await capture(() => runCreateOrder(createArgs()));
      assert.equal(exitCode, 1);
      assert.equal(payload.error.code, 'EXPIRY_UNPARSABLE');
    },
  );
});

test('status: shielded pay-in states and confirmations are surfaced; a seen pay-in is money', async () => {
  const seen = zecPayment({ payinState: 'seen', confirmations: 0 });
  await withHttp(
    [
      ['/invoice-status', () => json(invoiceStatusBody(seen))],
      [`/payments/${ID}`, () => json(seen)],
    ],
    async () => {
      const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
      assert.equal(payload.state, 'payin_detected');
      assert.equal(payload.moneyDetected, true);
      assert.equal(payload.sendWindow, null);
      assert.deepEqual([payload.payin.zec.payinState, payload.payin.zec.confirmations, payload.payin.zec.requiredConfirmations], ['seen', 0, 1]);
      assert.equal(payload.expiry.quoteExpiresAt, seen.source.zec.quoteExpiresAt);
    },
  );
  const awaiting = zecPayment();
  await withHttp(
    [
      ['/invoice-status', () => json(invoiceStatusBody(awaiting))],
      [`/payments/${ID}`, () => json(awaiting)],
    ],
    async () => {
      const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
      assert.equal(payload.state, 'awaiting_deposit');
      assert.equal(payload.payin.zec.receive, 'shielded');
    },
  );
  // a missing live price lock closes the send window, whatever a local record says
  const noLock = zecPayment({ quoteExpiresAt: null });
  await withHttp(
    [
      ['/invoice-status', () => json(invoiceStatusBody(noLock))],
      [`/payments/${ID}`, () => json(noLock)],
    ],
    async () => {
      const { payload } = await capture(() => runStatus(['--rozo-payment-id', ID]));
      assert.equal(payload.state, 'awaiting_deposit');
      assert.equal(payload.expiry.quoteExpiresAt, null);
      assert.equal(payload.sendWindow.ok, false);
      assert.equal(payload.sendWindow.code, 'EXPIRY_UNPARSABLE');
    },
  );
  // the generic classifier is untouched for a settled order
  const done = { ...zecPayment({ payinState: 'eligible', confirmations: 2, amountReceived: AMOUNT }), status: 'payment_payout_completed' };
  assert.equal(classifyStatus({ payment: done, routerState: { status: 'paid' }, coinbase: null }).state, 'settled');
});
