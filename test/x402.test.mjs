/**
 * x402 payer: challenge parsing, option selection, and the full pay flow
 * against a local mock server that plays both the paid endpoint and the Rozo
 * /v1/x402/* API. Nothing leaves 127.0.0.1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

const state = {
  routes: {},
  calls: [],
};

function resetServer() {
  state.routes = {};
  state.calls = [];
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
    state.calls.push({ key, headers: req.headers, body });
    const route = state.routes[key];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      return;
    }
    const step = Array.isArray(route) ? route.shift() ?? route.at(-1) : route;
    const r = typeof step === 'function' ? step(req, body) : step;
    if (Array.isArray(route) && route.length === 0) state.routes[key] = [step];
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-x402-'));
process.env.ROZO_CHECKOUT_STATE_DIR = path.join(tmp, 'state');
process.env.ROZO_CHECKOUT_X402_BASE = `${ORIGIN}/v1/x402`;
delete process.env.ROZO_CHECKOUT_X402_KEY;

const x402 = await import('../scripts/src/lib/x402.mjs');
const flows = await import('../scripts/src/x402.mjs');
const { parseX402Args, isX402Argv } = await import('../scripts/src/lib/x402-args.mjs');
const { redact } = await import('../scripts/src/lib/output.mjs');
const { keyPath } = await import('../scripts/src/lib/x402-key.mjs');

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const noSleep = async () => {};
const TEST_KEY = 'ak_test_0123456789abcdef';
const SELLER_EVM = '0x1111111111111111111111111111111111111111';
const SELLER_SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function v2Requirement(overrides = {}) {
  return {
    scheme: 'exact',
    network: x402.NETWORK_BASE,
    amount: '10000', // 0.01 USDC
    asset: x402.USDC_ASSET[x402.NETWORK_BASE],
    payTo: SELLER_EVM,
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
    ...overrides,
  };
}

function v2Challenge(accepts, extra = {}) {
  return {
    x402Version: 2,
    resource: { url: `${ORIGIN}/paid`, description: 'test', mimeType: 'application/json' },
    accepts,
    ...extra,
  };
}

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function withKey(fn) {
  return async () => {
    process.env.ROZO_CHECKOUT_X402_KEY = TEST_KEY;
    try {
      await fn();
    } finally {
      delete process.env.ROZO_CHECKOUT_X402_KEY;
    }
  };
}

/** Paid endpoint: 402 without a payment header, 200 + PAYMENT-RESPONSE with one. */
function paidEndpoint({ challenge, headerName = 'payment-signature', okBody = { result: 'paid content' } }) {
  return (req) => {
    if (!req.headers[headerName]) {
      return { status: 402, headers: { 'payment-required': b64(challenge) }, body: {} };
    }
    return {
      status: 200,
      headers: {
        'payment-response': b64({
          success: true,
          transaction: '0x' + 'ab'.repeat(32),
          network: x402.NETWORK_BASE,
          payer: '0x2222222222222222222222222222222222222222',
        }),
      },
      body: okBody,
    };
  };
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

test('parseChallenge: v2 PAYMENT-REQUIRED header', () => {
  const ch = v2Challenge([v2Requirement()]);
  const parsed = x402.parseChallenge({
    status: 402,
    getHeader: (n) => (n === 'payment-required' ? b64(ch) : null),
    bodyText: '',
  });
  assert.equal(parsed.x402Version, 2);
  assert.equal(parsed.source, 'header');
  assert.equal(parsed.accepts.length, 1);
  assert.equal(parsed.resource.url, `${ORIGIN}/paid`);
});

test('parseChallenge: v1 JSON body with short network names', () => {
  const body = JSON.stringify({
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [
      { scheme: 'exact', network: 'base', maxAmountRequired: '5000', asset: x402.USDC_ASSET[x402.NETWORK_BASE], payTo: SELLER_EVM },
    ],
  });
  const parsed = x402.parseChallenge({ status: 402, getHeader: () => null, bodyText: body });
  assert.equal(parsed.x402Version, 1);
  assert.equal(parsed.source, 'body');
  const opt = x402.selectRequirement(parsed, { budgetAtomic: 1_000_000n });
  assert.equal(opt.network, x402.NETWORK_BASE);
  assert.equal(opt.amountUsd, '0.005');
  assert.equal(x402.paymentHeaderName(parsed.x402Version), 'X-PAYMENT');
});

test('parseChallenge: 402 without requirements is X402_BAD_CHALLENGE', () => {
  assert.throws(
    () => x402.parseChallenge({ status: 402, getHeader: () => null, bodyText: '<html>pay</html>' }),
    (e) => e.code === 'X402_BAD_CHALLENGE',
  );
  assert.throws(
    () => x402.parseChallenge({ status: 402, getHeader: () => 'not-base64-json', bodyText: '{}' }),
    (e) => e.code === 'X402_BAD_CHALLENGE',
  );
});

test('selectRequirement: only exact USDC on Base or Solana is payable', () => {
  const ch = {
    x402Version: 2,
    accepts: [
      v2Requirement({ network: 'eip155:1' }),
      v2Requirement({ asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }), // USDT
      v2Requirement({ scheme: 'upto' }),
    ],
  };
  assert.throws(() => x402.selectRequirement(ch, { budgetAtomic: 10_000_000n }), (e) => e.code === 'X402_UNSUPPORTED');
});

test('selectRequirement: cheapest within budget, --prefer breaks the choice, over budget refused', () => {
  const ch = {
    x402Version: 2,
    accepts: [
      v2Requirement({ amount: '20000' }),
      v2Requirement({ network: x402.NETWORK_SOLANA, asset: x402.USDC_ASSET[x402.NETWORK_SOLANA], payTo: SELLER_SOL, amount: '15000' }),
    ],
  };
  assert.equal(x402.selectRequirement(ch, { budgetAtomic: 1_000_000n }).network, x402.NETWORK_SOLANA);
  assert.equal(x402.selectRequirement(ch, { budgetAtomic: 1_000_000n, prefer: 'base' }).network, x402.NETWORK_BASE);
  assert.throws(
    () => x402.selectRequirement(ch, { budgetAtomic: 10_000n }),
    (e) => e.code === 'X402_OVER_BUDGET' && e.details.askedUsd === '0.015',
  );
});

test('usdToAtomic / formatUsdc round trip and reject junk', () => {
  assert.equal(x402.usdToAtomic('1.00'), 1_000_000n);
  assert.equal(x402.usdToAtomic('0.000001'), 1n);
  assert.equal(x402.formatUsdc(1_500_000n), '1.50');
  assert.throws(() => x402.usdToAtomic('-1'), (e) => e.code === 'BAD_VALUE');
  assert.throws(() => x402.usdToAtomic('1e3'), (e) => e.code === 'BAD_VALUE');
});

test('extractSignature tolerates field-name drift and encodes a raw payload', () => {
  assert.equal(x402.extractSignature({ paymentSignature: 'abc' }), 'abc');
  assert.equal(x402.extractSignature({ 'PAYMENT-SIGNATURE': 'def' }), 'def');
  const encoded = x402.extractSignature({ paymentPayload: { x402Version: 2 } });
  assert.deepEqual(x402.decodeBase64Json(encoded), { x402Version: 2 });
  assert.equal(x402.extractSignature({}), null);
});

test('topup presets: native coins are topup only, unknown coin refused', () => {
  assert.deepEqual(x402.resolveTopupPreset('sol-solana'), { preset: 'sol-solana', chain: '900', token: 'SOL', native: true });
  assert.equal(x402.resolveTopupPreset('USDT-Solana').token, 'USDT');
  assert.throws(() => x402.resolveTopupPreset('doge-dogecoin'), (e) => e.code === 'BAD_PRESET');
});

test('agent keys are redacted from any output text', () => {
  assert.equal(redact(`key is ${TEST_KEY}`), 'key is ak_<redacted>');
  assert.equal(x402.maskKey(TEST_KEY), 'ak_…cdef');
});

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

test('parseX402Args: pay with repeated headers, body and budget', () => {
  const argv = ['x402', 'pay', 'https://api.example.test/x', '--method', 'post', '--body', '{"q":1}', '--header', 'A: 1', '--header', 'B: 2', '--max-usd', '0.25', '--json'];
  assert.equal(isX402Argv(argv), true);
  const o = parseX402Args(argv);
  assert.equal(o.sub, 'pay');
  assert.equal(o.method, 'POST');
  assert.deepEqual(o.headers, ['A: 1', 'B: 2']);
  assert.equal(o.maxUsd, '0.25');
  assert.equal(o.json, true);
});

test('parseX402Args: topup needs a coin; bad idempotency key refused; unknown sub refused', () => {
  assert.throws(() => parseX402Args(['x402', 'topup', '20']), (e) => e.code === 'MISSING_PRESET');
  assert.equal(parseX402Args(['x402', 'topup', '20', '--with', 'usdt-solana']).coin, 'usdt-solana');
  assert.throws(() => parseX402Args(['x402', 'pay', 'https://x.test', '--idempotency-key', 'nope']), (e) => e.code === 'BAD_VALUE');
  assert.throws(() => parseX402Args(['x402', 'withdraw']), (e) => e.code === 'UNKNOWN_COMMAND');
  assert.equal(isX402Argv(['pay', 'pl_123']), false);
});

test('parseHeaderFlags refuses to let the caller set the payment header', () => {
  assert.deepEqual(flows.parseHeaderFlags(['Authorization: Bearer x']), { Authorization: 'Bearer x' });
  assert.throws(() => flows.parseHeaderFlags(['PAYMENT-SIGNATURE: forged']), (e) => e.code === 'BAD_VALUE');
  assert.throws(() => flows.parseHeaderFlags(['no colon']), (e) => e.code === 'BAD_VALUE');
});

// ---------------------------------------------------------------------------
// Pay flow against the mock server
// ---------------------------------------------------------------------------

test('pay: 402 -> /sign (key, accepts, budget, idempotencyKey) -> replay with PAYMENT-SIGNATURE -> 200', withKey(async () => {
  resetServer();
  const challenge = v2Challenge([v2Requirement()]);
  state.routes['POST /paid'] = paidEndpoint({ challenge });
  state.routes['POST /v1/x402/sign'] = { status: 200, body: { paymentSignature: 'SIGNED-PAYLOAD', paymentId: 'xp_1' } };

  const out = await flows.runPay(
    { url: `${ORIGIN}/paid`, method: 'POST', body: '{"q":"hello"}', headers: { 'X-Seller-Key': 'seller-secret' }, maxUsd: '0.05' },
    { sleep: noSleep, uuid: () => '11111111-2222-4333-8444-555555555555' },
  );

  assert.equal(out.success, true);
  assert.equal(out.paid, true);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { result: 'paid content' });
  assert.equal(out.payment.amountUsd, '0.01');
  assert.equal(out.payment.network, x402.NETWORK_BASE);
  assert.equal(out.payment.paymentId, 'xp_1');
  assert.equal(out.payment.settlement.transaction, '0x' + 'ab'.repeat(32));

  const keys = state.calls.map((c) => c.key);
  assert.deepEqual(keys, ['POST /paid', 'POST /v1/x402/sign', 'POST /paid']);

  const sign = state.calls[1];
  assert.equal(sign.headers.authorization, `Bearer ${TEST_KEY}`);
  const signBody = JSON.parse(sign.body);
  assert.equal(signBody.idempotencyKey, '11111111-2222-4333-8444-555555555555');
  assert.equal(signBody.budget, '0.05');
  assert.equal(signBody.x402Version, 2);
  assert.deepEqual(signBody.accepts, [challenge.accepts[0]]);
  // Rozo never sees the request body or the seller's credentials.
  assert.doesNotMatch(sign.body, /hello|seller-secret/);

  const replay = state.calls[2];
  assert.equal(replay.headers['payment-signature'], 'SIGNED-PAYLOAD');
  assert.equal(replay.body, '{"q":"hello"}');
  assert.equal(replay.headers['x-seller-key'], 'seller-secret');
  // The agent key never goes to the seller.
  assert.equal(replay.headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(replay.headers), /ak_test/);
}));

test('pay: x402 v1 challenge is replayed with X-PAYMENT', withKey(async () => {
  resetServer();
  state.routes['GET /v1paid'] = (req) =>
    req.headers['x-payment']
      ? { status: 200, body: { ok: true } }
      : {
          status: 402,
          body: {
            x402Version: 1,
            accepts: [{ scheme: 'exact', network: 'solana', maxAmountRequired: '1000', asset: x402.USDC_ASSET[x402.NETWORK_SOLANA], payTo: SELLER_SOL }],
          },
        };
  state.routes['POST /v1/x402/sign'] = { status: 200, body: { paymentSignature: 'V1SIG' } };
  const out = await flows.runPay({ url: `${ORIGIN}/v1paid` }, { sleep: noSleep });
  assert.equal(out.paid, true);
  assert.equal(out.payment.network, x402.NETWORK_SOLANA);
  assert.equal(state.calls.at(-1).headers['x-payment'], 'V1SIG');
}));

test('pay: transient /sign failures are retried with the SAME idempotencyKey', withKey(async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement()]) });
  state.routes['POST /v1/x402/sign'] = [
    { status: 502, body: { error: 'BAD_GATEWAY' } },
    { status: 500, body: { error: 'INTERNAL' } },
    { status: 200, body: { paymentSignature: 'SIG-AFTER-RETRY' } },
  ];
  const out = await flows.runPay({ url: `${ORIGIN}/paid` }, { sleep: noSleep });
  assert.equal(out.paid, true);
  assert.equal(out.payment.signAttempts, 3);
  const signCalls = state.calls.filter((c) => c.key === 'POST /v1/x402/sign').map((c) => JSON.parse(c.body));
  assert.equal(signCalls.length, 3);
  const keys = new Set(signCalls.map((b) => b.idempotencyKey));
  assert.equal(keys.size, 1, 'every retry must carry the same idempotencyKey');
  assert.equal(state.calls.at(-1).headers['payment-signature'], 'SIG-AFTER-RETRY');
}));

test('pay: retries are bounded and the error carries the idempotencyKey to reuse', withKey(async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement()]) });
  state.routes['POST /v1/x402/sign'] = { status: 502, body: { error: 'BAD_GATEWAY' } };
  await assert.rejects(
    flows.runPay({ url: `${ORIGIN}/paid`, idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { sleep: noSleep }),
    (e) => e.details.idempotencyKey === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' && e.details.attempts === 1 + flows.SIGN_RETRIES,
  );
  assert.equal(state.calls.filter((c) => c.key === 'POST /v1/x402/sign').length, 1 + flows.SIGN_RETRIES);
  // never replayed without a signature
  assert.equal(state.calls.filter((c) => c.key === 'GET /paid').length, 1);
}));

test('pay: --idempotency-key from a previous run is sent unchanged', withKey(async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement()]) });
  state.routes['POST /v1/x402/sign'] = { status: 200, body: { paymentSignature: 'S' } };
  await flows.runPay({ url: `${ORIGIN}/paid`, idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { sleep: noSleep });
  const body = JSON.parse(state.calls.find((c) => c.key === 'POST /v1/x402/sign').body);
  assert.equal(body.idempotencyKey, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
}));

test('pay: 503 from /sign is the friendly "x402 payer not enabled yet", not retried', withKey(async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement()]) });
  state.routes['POST /v1/x402/sign'] = { status: 503, body: { error: 'X402_PAYER_OFF' } };
  await assert.rejects(
    flows.runPay({ url: `${ORIGIN}/paid` }, { sleep: noSleep }),
    (e) => e.code === 'X402_PAYER_DISABLED' && /x402 payer not enabled yet/.test(e.message),
  );
  assert.equal(state.calls.filter((c) => c.key === 'POST /v1/x402/sign').length, 1);
}));

test('balance and topup: 503 is the same friendly message', withKey(async () => {
  resetServer();
  state.routes['GET /v1/x402/balance'] = { status: 503, body: {} };
  state.routes['POST /v1/x402/topup'] = { status: 503, body: {} };
  await assert.rejects(flows.runBalance(), (e) => e.code === 'X402_PAYER_DISABLED');
  await assert.rejects(flows.runTopup({ amountUsd: '20', coin: 'usdt-solana' }), (e) => e.code === 'X402_PAYER_DISABLED');
}));

test('pay: a non-402 response passes through and nothing is signed', withKey(async () => {
  resetServer();
  state.routes['GET /free'] = { status: 200, body: { free: true } };
  const out = await flows.runPay({ url: `${ORIGIN}/free` }, { sleep: noSleep });
  assert.equal(out.paid, false);
  assert.deepEqual(out.body, { free: true });
  assert.equal(state.calls.length, 1);
}));

test('pay: seller rejects the payment (402 on replay) -> X402_PAYMENT_REJECTED, no second sign', withKey(async () => {
  resetServer();
  const challenge = v2Challenge([v2Requirement()]);
  state.routes['GET /paid'] = { status: 402, headers: { 'payment-required': b64({ ...challenge, error: 'invalid_signature' }) }, body: {} };
  state.routes['POST /v1/x402/sign'] = { status: 200, body: { paymentSignature: 'BAD' } };
  await assert.rejects(
    flows.runPay({ url: `${ORIGIN}/paid` }, { sleep: noSleep }),
    (e) => e.code === 'X402_PAYMENT_REJECTED' && /invalid_signature/.test(e.message),
  );
  assert.equal(state.calls.filter((c) => c.key === 'POST /v1/x402/sign').length, 1);
}));

test('pay: over budget is refused before Rozo is asked to sign', withKey(async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement({ amount: '2000000' })]) });
  await assert.rejects(flows.runPay({ url: `${ORIGIN}/paid`, maxUsd: '1.00' }, { sleep: noSleep }), (e) => e.code === 'X402_OVER_BUDGET');
  assert.equal(state.calls.some((c) => c.key === 'POST /v1/x402/sign'), false);
}));

test('pay: a blacklisted payTo is refused before Rozo is asked to sign', withKey(async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({
    challenge: v2Challenge([v2Requirement({ payTo: '0x5772FBe7a7817ef7F586215CA8b23b8dD22C8897' })]),
  });
  await assert.rejects(flows.runPay({ url: `${ORIGIN}/paid` }, { sleep: noSleep }), (e) => e.code === 'BLACKLIST_HIT');
  assert.equal(state.calls.some((c) => c.key === 'POST /v1/x402/sign'), false);
}));

test('pay: --dry-run reads the challenge and signs nothing', async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement()]) });
  const out = await flows.runPay({ url: `${ORIGIN}/paid`, dryRun: true }, { sleep: noSleep });
  assert.equal(out.dryRun, true);
  assert.equal(out.plan.amountUsd, '0.01');
  assert.equal(state.calls.length, 1);
});

test('pay without a key explains how to get one', async () => {
  resetServer();
  state.routes['GET /paid'] = paidEndpoint({ challenge: v2Challenge([v2Requirement()]) });
  await assert.rejects(flows.runPay({ url: `${ORIGIN}/paid` }, { sleep: noSleep }), (e) => e.code === 'X402_NO_KEY' && /x402 topup/.test(e.message));
});

// ---------------------------------------------------------------------------
// Topup and balance
// ---------------------------------------------------------------------------

test('topup: creates a key once (0600 file), then sends {amount, token, chain} with it', async () => {
  resetServer();
  fs.rmSync(keyPath(), { force: true });
  state.routes['POST /v1/x402/keys'] = { status: 200, body: { key: 'ak_new_9876543210fedcba' } };
  state.routes['POST /v1/x402/topup'] = {
    status: 200,
    body: { orderId: 'ord_1', depositAddress: SELLER_SOL, payAmount: '20.2', token: 'USDT', chain: '900', expiresAt: '2026-10-10T12:00:00Z' },
  };

  const out = await flows.runTopup({ amountUsd: '20', coin: 'usdt-solana' });
  assert.equal(out.keyCreated.keyMasked, 'ak_…dcba');
  assert.equal(out.deposit.address, SELLER_SOL);
  assert.equal(out.deposit.amount, '20.2');
  assert.doesNotMatch(JSON.stringify(out), /ak_new_9876543210fedcba/);

  const stat = fs.statSync(keyPath());
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(keyPath(), 'utf8').trim(), 'ak_new_9876543210fedcba');

  const topupCall = state.calls.find((c) => c.key === 'POST /v1/x402/topup');
  assert.deepEqual(JSON.parse(topupCall.body), { amount: '20', token: 'USDT', chain: '900' });
  assert.equal(topupCall.headers.authorization, 'Bearer ak_new_9876543210fedcba');

  // Second topup reuses the stored key; no second /keys call.
  await flows.runTopup({ amountUsd: '5', coin: 'sol-solana' });
  assert.equal(state.calls.filter((c) => c.key === 'POST /v1/x402/keys').length, 1);
  const second = JSON.parse(state.calls.filter((c) => c.key === 'POST /v1/x402/topup')[1].body);
  assert.deepEqual(second, { amount: '5', token: 'SOL', chain: '900' });
  fs.rmSync(keyPath(), { force: true });
});

test('topup: below minimum and malformed amounts refused locally', async () => {
  await assert.rejects(flows.runTopup({ amountUsd: '4.99', coin: 'usdt-solana' }), (e) => e.code === 'BAD_VALUE');
  await assert.rejects(flows.runTopup({ amountUsd: '1e2', coin: 'usdt-solana' }), (e) => e.code === 'BAD_VALUE');
});

test('topup: a blacklisted deposit address from the server is refused', withKey(async () => {
  resetServer();
  state.routes['POST /v1/x402/topup'] = {
    status: 200,
    body: { orderId: 'ord_2', depositAddress: 'AEEtekA2EBYVy3e5Xx8fD3GkjWSoCsLvLzdD6pZTgHiH', payAmount: '20', token: 'USDC', chain: '900' },
  };
  await assert.rejects(flows.runTopup({ amountUsd: '20', coin: 'usdc-solana' }), (e) => e.code === 'BLACKLIST_HIT');
}));

test('balance: sends the key, returns balance fields', withKey(async () => {
  resetServer();
  state.routes['GET /v1/x402/balance'] = { status: 200, body: { balanceUsd: '19.80', limits: { perPaymentUsd: '5', dailyUsd: '100' } } };
  const out = await flows.runBalance();
  assert.equal(out.balanceUsd, '19.80');
  assert.equal(out.limits.dailyUsd, '100');
  assert.equal(state.calls[0].headers.authorization, `Bearer ${TEST_KEY}`);
}));

test('pay: replay failing after signing keeps the idempotencyKey (no silent second charge)', withKey(async () => {
  resetServer();
  const challenge = v2Challenge([v2Requirement()]);
  state.routes['POST /v1/x402/sign'] = { status: 200, body: { paymentSignature: 'S', paymentId: 'xp_9' } };
  // First call answers 402; every paid replay dies at the network layer.
  let n = 0;
  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/paid')) {
      n += 1;
      if (n > 1) throw new TypeError('socket hang up');
      return new Response('{}', { status: 402, headers: { 'payment-required': b64(challenge) } });
    }
    return realFetch(url, init);
  };
  await assert.rejects(
    flows.runPay({ url: `${ORIGIN}/paid`, idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { sleep: noSleep, fetchImpl }),
    (e) =>
      e.code === 'X402_REPLAY_FAILED' &&
      e.details.idempotencyKey === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' &&
      e.details.paymentId === 'xp_9' &&
      e.details.signed === true,
  );
  assert.equal(n, 3, 'one unpaid call plus exactly two paid replays');
}));

test('pay: the request URL (query may hold seller credentials) is never sent to Rozo', withKey(async () => {
  resetServer();
  // v1 challenge with no top-level resource
  state.routes['GET /v1paid'] = (req) =>
    req.headers['x-payment']
      ? { status: 200, body: { ok: true } }
      : {
          status: 402,
          body: {
            x402Version: 1,
            accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', asset: x402.USDC_ASSET[x402.NETWORK_BASE], payTo: SELLER_EVM }],
          },
        };
  state.routes['POST /v1/x402/sign'] = { status: 200, body: { paymentSignature: 'S' } };
  await flows.runPay({ url: `${ORIGIN}/v1paid?api_key=seller-secret-123` }, { sleep: noSleep });
  const sign = state.calls.find((c) => c.key === 'POST /v1/x402/sign');
  assert.doesNotMatch(sign.body, /seller-secret-123|api_key/);
  assert.equal('resource' in JSON.parse(sign.body), false);
}));
