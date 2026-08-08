/**
 * The optional balance assistance in the picker.
 *
 * All pure: address-family detection, request shaping, response mapping, and
 * the graceful-degrade path. No network — the fixture is the real response
 * shape from the balance service.
 *
 * The property that matters most here is that this feature can only ever
 * ADD information. It must never mark something affordable that is not, and
 * must never claim a shortfall it cannot prove.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectAddressFamily,
  familyCoversChain,
  buildBalanceRequest,
  parsePaymentOptions,
  markPickerOptions,
  isProvablyShort,
  fetchWalletOptions,
  INTENT_API_BASE,
  APP_ID,
} from '../scripts/src/lib/wallet-check.mjs';
import { PICKER_OPTIONS } from '../scripts/src/lib/cli-args.mjs';
import { readFixture } from './helpers.mjs';

const EVM = '0xdC4313EfB37836615d820F38A6016EE76598887B';
const SOL = 'BK1CMQ2kSvxUNa8pZsfvN2UoZDHWVwgYsXKUVZgURAGF';
const XLM = 'GDATMUNQEPN4TPETV47LAKGJELK4DUHHDRPMGD3K5LOHUPXX2DI623KY';

test('address families are detected, and nothing else is guessed', () => {
  assert.equal(detectAddressFamily(EVM), 'evm');
  assert.equal(detectAddressFamily(EVM.toLowerCase()), 'evm');
  assert.equal(detectAddressFamily(SOL), 'solana');
  assert.equal(detectAddressFamily(XLM), 'stellar');
  assert.equal(detectAddressFamily(`  ${EVM}  `), 'evm');

  for (const bad of ['', '   ', null, undefined, 'hello', '0x123', 'bc1qxyz', 42]) {
    assert.equal(detectAddressFamily(bad), null, JSON.stringify(bad));
  }
});

test('a Stellar address is never mistaken for Solana', () => {
  // Both are alphanumeric and similar in length; Stellar must win.
  assert.equal(detectAddressFamily(XLM), 'stellar');
  assert.notEqual(detectAddressFamily(XLM), 'solana');
});

test('a family only vouches for chains it can actually see', () => {
  assert.ok(familyCoversChain('evm', '1'));
  assert.ok(familyCoversChain('evm', '8453'));
  assert.ok(familyCoversChain('evm', '56'));
  assert.ok(!familyCoversChain('evm', '900'));
  assert.ok(!familyCoversChain('evm', '1500'));
  assert.ok(familyCoversChain('solana', '900'));
  assert.ok(!familyCoversChain('solana', '1'));
  assert.ok(familyCoversChain('stellar', '1500'));
  // Nobody can vouch for a Lightning wallet.
  for (const f of ['evm', 'solana', 'stellar']) {
    assert.ok(!familyCoversChain(f, 'lightning'), f);
  }
});

test('requests are shaped per family, with our own appId', () => {
  const evm = buildBalanceRequest({ family: 'evm', address: EVM, usdRequired: 1050 });
  assert.ok(evm.startsWith(`${INTENT_API_BASE}/getWalletPaymentOptions?input=`));
  const evmInput = JSON.parse(decodeURIComponent(evm.split('input=')[1]));
  assert.deepEqual(evmInput['0'], {
    payerAddress: EVM,
    usdRequired: 1050,
    destChainId: 8453,
    appId: APP_ID,
  });

  const sol = buildBalanceRequest({ family: 'solana', address: SOL, usdRequired: 1050 });
  assert.ok(sol.includes('/getSolanaPaymentOptions'));
  assert.equal(JSON.parse(decodeURIComponent(sol.split('input=')[1]))['0'].pubKey, SOL);

  const xlm = buildBalanceRequest({ family: 'stellar', address: XLM, usdRequired: 1050 });
  assert.ok(xlm.includes('/getStellarPaymentOptions'));
  assert.equal(JSON.parse(decodeURIComponent(xlm.split('input=')[1]))['0'].stellarAddress, XLM);

  assert.throws(
    () => buildBalanceRequest({ family: 'evm', address: EVM, usdRequired: 0 }),
    (e) => e.code === 'BAD_USD_REQUIRED',
  );
  assert.throws(
    () => buildBalanceRequest({ family: 'tron', address: 'T...', usdRequired: 5 }),
    (e) => e.code === 'BAD_ADDRESS_FAMILY',
  );
});

test('the real response shape parses into the fields the picker needs', () => {
  const options = parsePaymentOptions(readFixture('wallet-options-evm.json'));
  assert.equal(options.length, 3);
  assert.deepEqual(options[0], {
    chainId: '8453',
    tokenSymbol: 'USDC',
    balanceUsd: 2500,
    requiredUsd: 1050,
    affordable: true,
    disabledReason: null,
  });
  // The backend's own disabledReason is authoritative.
  assert.equal(options[1].affordable, false);
  assert.equal(options[1].balanceUsd, 12);
});

test('a malformed or empty response yields no options rather than throwing', () => {
  for (const junk of [null, undefined, {}, [], 'nope', 42, [{ result: {} }], { data: 'x' }]) {
    assert.deepEqual(parsePaymentOptions(junk), [], JSON.stringify(junk));
  }
});

test('picker marking: affordable first, mismatched families unchecked', () => {
  const options = parsePaymentOptions(readFixture('wallet-options-evm.json'));
  const marked = markPickerOptions(PICKER_OPTIONS, { family: 'evm', options });

  assert.equal(marked.length, PICKER_OPTIONS.length, 'no row may be dropped');

  const byPreset = Object.fromEntries(marked.map((m) => [m.preset, m]));
  assert.equal(byPreset['usdc-base'].mark, 'affordable');
  assert.equal(byPreset['usdc-base'].balanceUsd, 2500);
  assert.equal(byPreset['usdc-ethereum'].mark, 'affordable');
  assert.equal(byPreset['usdt-bnb'].mark, 'insufficient');

  // An EVM address says nothing about Solana, Stellar or Lightning rows.
  for (const p of ['usdt-solana', 'usdc-solana', 'usdc-stellar', 'btc-lightning']) {
    assert.equal(byPreset[p].mark, 'unchecked', p);
    assert.equal(byPreset[p].balanceUsd, null, p);
  }

  // Affordable rows sort ahead of unchecked, which sort ahead of insufficient.
  const marks = marked.map((m) => m.mark);
  const rank = { affordable: 0, unchecked: 1, insufficient: 2 };
  const ranks = marks.map((m) => rank[m]);
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'rows must be grouped by mark');
});

test('with no address, every row is simply unchecked and order is preserved', () => {
  const marked = markPickerOptions(PICKER_OPTIONS, {});
  assert.equal(marked.length, PICKER_OPTIONS.length);
  assert.ok(marked.every((m) => m.mark === 'unchecked'));
  assert.deepEqual(
    marked.map((m) => m.number),
    PICKER_OPTIONS.map((o) => o.number),
  );
});

test('a shortfall is only claimed on positive evidence', () => {
  const options = parsePaymentOptions(readFixture('wallet-options-evm.json'));
  const ok = { ok: true, family: 'evm', options };

  // Proven short.
  assert.equal(isProvablyShort({ chainId: '56', tokenSymbol: 'USDT' }, ok), true);
  // Proven fine.
  assert.equal(isProvablyShort({ chainId: '8453', tokenSymbol: 'USDC' }, ok), false);
  // Wrong family for the row: unknowable, so never "short".
  assert.equal(isProvablyShort({ chainId: '900', tokenSymbol: 'USDT' }, ok), false);
  // Not present in the response at all: unknowable.
  assert.equal(isProvablyShort({ chainId: '137', tokenSymbol: 'USDC' }, ok), false);
  // Lookup failed entirely: unknowable.
  assert.equal(
    isProvablyShort({ chainId: '56', tokenSymbol: 'USDT' }, { ok: false, family: 'evm', options: [] }),
    false,
  );
  assert.equal(isProvablyShort({ chainId: '56', tokenSymbol: 'USDT' }, { ok: true, family: null, options: [] }), false);
});

test('a failed lookup degrades gracefully instead of throwing', async () => {
  // Unrecognised address: refused locally, no network touched.
  const bad = await fetchWalletOptions({ address: 'not-an-address', usdRequired: 1050 });
  assert.equal(bad.ok, false);
  assert.equal(bad.family, null);
  assert.deepEqual(bad.options, []);
  assert.match(bad.reason, /unrecognised/);

  // Unreachable host with a tiny timeout: still resolves, never rejects.
  const prev = process.env.ROZO_CHECKOUT_INTENT_API;
  try {
    const mod = await import(
      `../scripts/src/lib/wallet-check.mjs?nocache=${Date.now()}`
    );
    const res = await mod.fetchWalletOptions({
      address: EVM,
      usdRequired: 1050,
      timeoutMs: 1,
    });
    assert.equal(res.ok, false);
    assert.deepEqual(res.options, []);
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
  } finally {
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_INTENT_API;
    else process.env.ROZO_CHECKOUT_INTENT_API = prev;
  }
});
