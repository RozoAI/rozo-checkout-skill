/**
 * CLI argument parsing and coin presets.
 *
 * A preset that resolves to the wrong chain would send real money to the wrong
 * network, so every mapping is asserted explicitly rather than derived.
 * Pure functions only — no network, no TTY, no subprocesses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCliArgs,
  resolvePreset,
  listPresets,
  CliError,
  CHAIN_ALIASES,
  HELP,
  PICKER_OPTIONS,
  pickerOptionsFor,
  resolvePickerChoice,
} from '../scripts/src/lib/cli-args.mjs';
import { isSupportedSource } from '../scripts/src/lib/amounts.mjs';

test('presets map to exactly the right chain and token', () => {
  const expected = {
    'usdt-solana': { chainId: '900', tokenSymbol: 'USDT' },
    'usdc-solana': { chainId: '900', tokenSymbol: 'USDC' },
    'usdc-base': { chainId: '8453', tokenSymbol: 'USDC' },
    'usdt-bnb': { chainId: '56', tokenSymbol: 'USDT' },
    'usdc-bnb': { chainId: '56', tokenSymbol: 'USDC' },
    'usdt-ethereum': { chainId: '1', tokenSymbol: 'USDT' },
    'usdc-ethereum': { chainId: '1', tokenSymbol: 'USDC' },
    'usdt-polygon': { chainId: '137', tokenSymbol: 'USDT' },
    'usdc-polygon': { chainId: '137', tokenSymbol: 'USDC' },
    'usdc-stellar': { chainId: '1500', tokenSymbol: 'USDC' },
    'btc-lightning': { chainId: 'lightning', tokenSymbol: 'BTC' },
    'usdc-arbitrum': { chainId: '42161', tokenSymbol: 'USDC' },
    'usdt-arbitrum': { chainId: '42161', tokenSymbol: 'USDT' },
    'eth-ethereum': { chainId: '1', tokenSymbol: 'ETH' },
    'eth-base': { chainId: '8453', tokenSymbol: 'ETH' },
    'eth-arbitrum': { chainId: '42161', tokenSymbol: 'ETH' },
    'bnb-bnb': { chainId: '56', tokenSymbol: 'BNB' },
    'sol-solana': { chainId: '900', tokenSymbol: 'SOL' },
    'pol-polygon': { chainId: '137', tokenSymbol: 'POL' },
  };
  for (const [preset, want] of Object.entries(expected)) {
    assert.deepEqual(resolvePreset(preset), want, preset);
  }
});

test('chain aliases resolve to the same chain as their canonical name', () => {
  assert.deepEqual(resolvePreset('usdt-sol'), resolvePreset('usdt-solana'));
  assert.deepEqual(resolvePreset('usdt-bsc'), resolvePreset('usdt-bnb'));
  assert.deepEqual(resolvePreset('usdt-eth'), resolvePreset('usdt-ethereum'));
  assert.deepEqual(resolvePreset('usdt-matic'), resolvePreset('usdt-polygon'));
  assert.deepEqual(resolvePreset('btc-ln'), resolvePreset('btc-lightning'));
  assert.deepEqual(resolvePreset('usdc-xlm'), resolvePreset('usdc-stellar'));
  assert.deepEqual(resolvePreset('usdc-arb'), resolvePreset('usdc-arbitrum'));
  assert.deepEqual(resolvePreset('eth-arb'), resolvePreset('eth-arbitrum'));
  assert.deepEqual(resolvePreset('eth-eth'), resolvePreset('eth-ethereum'));
  assert.deepEqual(resolvePreset('bnb-bsc'), resolvePreset('bnb-bnb'));
  assert.deepEqual(resolvePreset('sol-sol'), resolvePreset('sol-solana'));
  assert.deepEqual(resolvePreset('pol-matic'), resolvePreset('pol-polygon'));
});

test('single-chain native coins have a one-word shortcut; ETH does not', () => {
  assert.deepEqual(resolvePreset('bnb'), { chainId: '56', tokenSymbol: 'BNB' });
  assert.deepEqual(resolvePreset('SOL'), { chainId: '900', tokenSymbol: 'SOL' });
  assert.deepEqual(resolvePreset(' pol '), { chainId: '137', tokenSymbol: 'POL' });
  // ETH lives on three chains: guessing one would be a way to lose money.
  assert.throws(() => resolvePreset('eth'), (e) => e.code === 'BAD_PRESET' && /eth-ethereum, eth-base or eth-arbitrum/.test(e.message));
  // --with goes through the same resolver.
  assert.deepEqual(parseCliArgs(['pay', 'pl_01ABC', '--with', 'sol']).source, { chainId: '900', tokenSymbol: 'SOL' });
  assert.deepEqual(parseCliArgs(['pay', 'pl_01ABC', '--with', 'eth-base']).source, { chainId: '8453', tokenSymbol: 'ETH' });
  assert.deepEqual(parseCliArgs(['pay', 'pl_01ABC', '--chain', '42161', '--token', 'eth']).source, { chainId: '42161', tokenSymbol: 'ETH' });
});

test('presets are case- and whitespace-insensitive', () => {
  const want = { chainId: '900', tokenSymbol: 'USDT' };
  for (const p of ['USDT-SOLANA', '  usdt-Solana  ', 'Usdt-SOLANA']) {
    assert.deepEqual(resolvePreset(p), want, p);
  }
});

test('every advertised preset is actually supported', () => {
  const presets = listPresets();
  assert.ok(presets.length >= 11);
  for (const p of presets) {
    const { chainId, tokenSymbol } = resolvePreset(p);
    assert.ok(isSupportedSource(chainId, tokenSymbol), `${p} must be supported`);
  }
  // And the help text advertises only presets that resolve.
  for (const m of HELP.match(/\b(usdt|usdc|btc)-[a-z]+\b/g) || []) {
    assert.doesNotThrow(() => resolvePreset(m), `HELP mentions unusable preset ${m}`);
  }
});

test('unsupported and malformed presets are refused, never guessed', () => {
  // Real chain, wrong token for it.
  assert.throws(() => resolvePreset('usdt-base'), (e) => e.code === 'UNSUPPORTED_SOURCE');
  assert.throws(() => resolvePreset('usdt-stellar'), (e) => e.code === 'UNSUPPORTED_SOURCE');
  // A native coin only on its own chain.
  assert.throws(() => resolvePreset('sol-ethereum'), (e) => e.code === 'UNSUPPORTED_SOURCE');
  assert.throws(() => resolvePreset('eth-polygon'), (e) => e.code === 'UNSUPPORTED_SOURCE');
  assert.throws(() => resolvePreset('bnb-base'), (e) => e.code === 'UNSUPPORTED_SOURCE');
  assert.throws(() => resolvePreset('usdt-base'), (e) => e.code === 'UNSUPPORTED_SOURCE');
  // On-chain BTC and Tron are not supported.
  // ("btc-bitcoin" is an alias for Lightning, the only BTC rail.)
  assert.deepEqual(resolvePreset('btc-bitcoin'), { chainId: 'lightning', tokenSymbol: 'BTC' });
  assert.throws(() => resolvePreset('usdt-tron'), (e) => e.code === 'BAD_PRESET');
  // Unknown chain.
  assert.throws(() => resolvePreset('usdc-avalanche'), (e) => e.code === 'BAD_PRESET');
  // Malformed.
  for (const bad of ['', '   ', 'usdt', 'usdt-', '-solana', undefined, null]) {
    assert.throws(() => resolvePreset(bad), CliError, JSON.stringify(bad));
  }
});

test('every alias points at a chain the amounts table knows', () => {
  for (const [alias, chainId] of Object.entries(CHAIN_ALIASES)) {
    assert.ok(
      ['1', '56', '137', '8453', '42161', '900', '1500', 'lightning'].includes(chainId),
      `alias ${alias} -> ${chainId}`,
    );
  }
});

test('pay: minimal invocation', () => {
  const r = parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana']);
  assert.equal(r.command, 'pay');
  assert.equal(r.target, 'pl_01ABC');
  assert.deepEqual(r.source, { chainId: '900', tokenSymbol: 'USDT' });
  // Safe defaults: no sending, no skipping confirmation.
  assert.equal(r.send, false);
  assert.equal(r.yes, false);
  assert.equal(r.json, false);
  assert.equal(r.watch, true);
  assert.equal(r.timeout, 900);
  assert.equal(r.timeoutExplicit, false);
});

test('pay: flags', () => {
  const r = parseCliArgs([
    'pay',
    'https://payments.coinbase.com/payment-links/pl_01ABC',
    '--with',
    'usdc-base',
    '--send',
    '--yes',
    '--json',
    '--no-watch',
    '--timeout',
    '120',
    '--rpc',
    'https://rpc.example.com',
  ]);
  assert.equal(r.send, true);
  assert.equal(r.yes, true);
  assert.equal(r.json, true);
  assert.equal(r.watch, false);
  assert.equal(r.timeout, 120);
  assert.equal(r.timeoutExplicit, true);
  assert.equal(r.rpc, 'https://rpc.example.com');
  assert.deepEqual(r.source, { chainId: '8453', tokenSymbol: 'USDC' });
});

test('pay: --flag=value form and short flags', () => {
  const r = parseCliArgs(['pay', 'pl_01ABC', '--with=usdt-bnb', '-y', '-j']);
  assert.deepEqual(r.source, { chainId: '56', tokenSymbol: 'USDT' });
  assert.equal(r.yes, true);
  assert.equal(r.json, true);
});

test('pay: raw --chain/--token instead of a preset', () => {
  const r = parseCliArgs(['pay', 'pl_01ABC', '--chain', '900', '--token', 'usdt']);
  assert.deepEqual(r.source, { chainId: '900', tokenSymbol: 'USDT' });

  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--chain', '900']),
    (e) => e.code === 'MISSING_VALUE',
  );
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--token', 'USDT']),
    (e) => e.code === 'MISSING_VALUE',
  );
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--chain', '8453', '--token', 'USDT']),
    (e) => e.code === 'UNSUPPORTED_SOURCE',
  );
  // Mixing the two forms is ambiguous, so it is refused rather than ranked.
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana', '--chain', '900', '--token', 'USDT']),
    (e) => e.code === 'CONFLICTING_FLAGS',
  );
});

test('pay: a missing target is a usage error; a missing coin defers to the caller', () => {
  assert.throws(() => parseCliArgs(['pay']), (e) => e.code === 'MISSING_TARGET');
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with']),
    (e) => e.code === 'MISSING_VALUE',
  );
  // No coin is no longer a parse error: parsing reports "none chosen" and the
  // CLI decides — picker on a terminal, hard refusal for a script.
  const r = parseCliArgs(['pay', 'pl_01ABC']);
  assert.equal(r.command, 'pay');
  assert.equal(r.source, null);
});

test('picker: the menu covers every supported combo exactly once', () => {
  assert.equal(PICKER_OPTIONS.length, listPresets().length);
  const seen = new Set();
  for (const o of PICKER_OPTIONS) {
    const key = `${o.chainId}:${o.tokenSymbol}`;
    assert.ok(!seen.has(key), `duplicate entry for ${key}`);
    seen.add(key);
    // Every menu entry must resolve through the normal preset path too, so the
    // echoed "--with" shortcut is always one the user could have typed.
    assert.deepEqual(resolvePreset(o.preset), {
      chainId: o.chainId,
      tokenSymbol: o.tokenSymbol,
    }, o.preset);
  }
  // Numbering is 1..n, contiguous and in order.
  assert.deepEqual(
    PICKER_OPTIONS.map((o) => o.number),
    PICKER_OPTIONS.map((_, i) => i + 1),
  );
  // Grouped: USDT block, then USDC, then BTC, then the native coins.
  assert.deepEqual([...new Set(PICKER_OPTIONS.map((o) => o.group))], ['USDT', 'USDC', 'BTC', 'Native coins']);
  // Native rows are flagged and name their coin.
  for (const o of PICKER_OPTIONS) {
    assert.equal(o.native, o.group === 'Native coins', o.preset);
    if (o.native) assert.match(o.label, new RegExp(`^${o.tokenSymbol} on `));
  }
});

test('picker: numbers map to the right chain and token (full menu)', () => {
  const expected = {
    1: { chainId: '900', tokenSymbol: 'USDT', preset: 'usdt-solana' },
    2: { chainId: '56', tokenSymbol: 'USDT', preset: 'usdt-bnb' },
    3: { chainId: '1', tokenSymbol: 'USDT', preset: 'usdt-ethereum' },
    4: { chainId: '137', tokenSymbol: 'USDT', preset: 'usdt-polygon' },
    5: { chainId: '42161', tokenSymbol: 'USDT', preset: 'usdt-arbitrum' },
    6: { chainId: '900', tokenSymbol: 'USDC', preset: 'usdc-solana' },
    7: { chainId: '56', tokenSymbol: 'USDC', preset: 'usdc-bnb' },
    8: { chainId: '1', tokenSymbol: 'USDC', preset: 'usdc-ethereum' },
    9: { chainId: '137', tokenSymbol: 'USDC', preset: 'usdc-polygon' },
    10: { chainId: '8453', tokenSymbol: 'USDC', preset: 'usdc-base' },
    11: { chainId: '42161', tokenSymbol: 'USDC', preset: 'usdc-arbitrum' },
    12: { chainId: '1500', tokenSymbol: 'USDC', preset: 'usdc-stellar' },
    13: { chainId: 'lightning', tokenSymbol: 'BTC', preset: 'btc-lightning' },
    14: { chainId: '8453', tokenSymbol: 'ETH', preset: 'eth-base' },
    15: { chainId: '1', tokenSymbol: 'ETH', preset: 'eth-ethereum' },
    16: { chainId: '42161', tokenSymbol: 'ETH', preset: 'eth-arbitrum' },
    17: { chainId: '56', tokenSymbol: 'BNB', preset: 'bnb-bnb' },
    18: { chainId: '900', tokenSymbol: 'SOL', preset: 'sol-solana' },
    19: { chainId: '137', tokenSymbol: 'POL', preset: 'pol-polygon' },
  };
  assert.equal(Object.keys(expected).length, PICKER_OPTIONS.length);
  for (const [n, want] of Object.entries(expected)) {
    assert.deepEqual(resolvePickerChoice(n), want, `choice ${n}`);
    assert.deepEqual(resolvePickerChoice(Number(n)), want, `choice ${n} as a number`);
  }
  // Whitespace is forgiven; the meaning is not changed.
  assert.deepEqual(resolvePickerChoice('  1  '), expected[1]);
});

test('picker: native coins show only when the quote offers them, numbers stay contiguous', () => {
  // No predicate: no native coin is ever assumed.
  const plain = pickerOptionsFor();
  assert.equal(plain.length, 13);
  assert.ok(plain.every((o) => !o.native));
  assert.deepEqual(plain.map((o) => o.number), plain.map((_, i) => i + 1));
  assert.throws(() => resolvePickerChoice('14', plain), (e) => e.code === 'BAD_CHOICE');

  // The quote offers Base ETH and SOL only.
  const offered = new Set(['8453:ETH', '900:SOL']);
  const some = pickerOptionsFor((cid, sym) => offered.has(`${cid}:${sym}`));
  assert.deepEqual(some.filter((o) => o.native).map((o) => o.preset), ['eth-base', 'sol-solana']);
  assert.deepEqual(some.map((o) => o.number), some.map((_, i) => i + 1));
  assert.deepEqual(resolvePickerChoice('14', some), { chainId: '8453', tokenSymbol: 'ETH', preset: 'eth-base' });
  assert.deepEqual(resolvePickerChoice('15', some), { chainId: '900', tokenSymbol: 'SOL', preset: 'sol-solana' });
  assert.throws(() => resolvePickerChoice('16', some), (e) => e.code === 'BAD_CHOICE');
});

test('picker: out-of-range and junk input are refused, never guessed', () => {
  for (const bad of ['0', '20', '99', '-1', '', '   ', null, undefined]) {
    assert.throws(() => resolvePickerChoice(bad), CliError, JSON.stringify(bad));
  }
  assert.throws(() => resolvePickerChoice('0'), (e) => e.code === 'BAD_CHOICE');
  assert.throws(() => resolvePickerChoice('20'), (e) => e.code === 'BAD_CHOICE');
  // A typed preset name still works, for anyone who knows it already.
  assert.deepEqual(resolvePickerChoice('usdt-solana'), {
    chainId: '900',
    tokenSymbol: 'USDT',
    preset: 'usdt-solana',
  });
  // But an unsupported one is refused with the normal preset error.
  assert.throws(() => resolvePickerChoice('usdt-base'), (e) => e.code === 'UNSUPPORTED_SOURCE');
});

test('picker: no numeric choice silently maps to Base USDC', () => {
  // Guard against the specific failure mode of defaulting to the settlement
  // chain: only choice 9 is usdc-base, and nothing else may resolve to it.
  for (const o of PICKER_OPTIONS) {
    if (o.preset === 'usdc-base') continue;
    const r = resolvePickerChoice(String(o.number));
    assert.ok(
      !(r.chainId === '8453' && r.tokenSymbol === 'USDC'),
      `choice ${o.number} must not resolve to Base USDC`,
    );
  }
});

test('pay: --payer and --fresh', () => {
  const r = parseCliArgs([
    'pay', 'pl_01ABC', '--with', 'usdt-solana',
    '--payer', '0xdC4313EfB37836615d820F38A6016EE76598887B',
    '--fresh',
  ]);
  assert.equal(r.payer, '0xdC4313EfB37836615d820F38A6016EE76598887B');
  assert.equal(r.fresh, true);

  // Both are optional and default to off.
  const plain = parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana']);
  assert.equal(plain.payer, undefined);
  assert.equal(plain.fresh, false);

  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana', '--payer']),
    (e) => e.code === 'MISSING_VALUE',
  );
});

test('quote and status', () => {
  assert.deepEqual(parseCliArgs(['quote', 'pl_01ABC']), {
    command: 'quote',
    target: 'pl_01ABC',
    json: false,
  });
  const s = parseCliArgs(['status', '11111111-2222-4333-8444-555555555555', '--watch']);
  assert.equal(s.command, 'status');
  assert.equal(s.watch, true);
  // Undefined so status sizes the window (600s, or a Lightning invoice's validity).
  assert.equal(s.timeout, undefined);
  const t = parseCliArgs(['status', '11111111-2222-4333-8444-555555555555', '--watch', '--timeout', '30']);
  assert.equal(t.timeout, 30);
  assert.throws(() => parseCliArgs(['quote']), (e) => e.code === 'MISSING_TARGET');
  assert.throws(() => parseCliArgs(['status']), (e) => e.code === 'MISSING_TARGET');
});

test('help and version', () => {
  for (const argv of [[], ['help'], ['--help'], ['-h'], ['pay', '--help']]) {
    assert.equal(parseCliArgs(argv).command, 'help', JSON.stringify(argv));
  }
  assert.equal(parseCliArgs(['--version']).command, 'version');
  assert.equal(parseCliArgs(['-v']).command, 'version');
});

test('--yes-large no longer exists: the payment limit has no override', () => {
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana', '--yes-large']),
    (e) => e.code === 'UNKNOWN_FLAG',
  );
  assert.doesNotMatch(HELP, /yes-large/);
});

test('unknown commands and flags are refused with a usable message', () => {
  const e1 = (() => {
    try {
      parseCliArgs(['frobnicate']);
    } catch (e) {
      return e;
    }
  })();
  assert.equal(e1.code, 'UNKNOWN_COMMAND');
  assert.match(e1.message, /pay, quote, status/);

  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana', '--force']),
    (e) => e.code === 'UNKNOWN_FLAG',
  );
  assert.throws(() => parseCliArgs(['pay', '-x']), (e) => e.code === 'UNKNOWN_FLAG');
});

test('--timeout must be a sane number', () => {
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana', '--timeout', 'soon']),
    (e) => e.code === 'BAD_VALUE',
  );
  assert.throws(
    () => parseCliArgs(['pay', 'pl_01ABC', '--with', 'usdt-solana', '--timeout', '-5']),
    (e) => e.code === 'BAD_VALUE',
  );
});

test('a link that looks like a flag value is still treated as the target', () => {
  const r = parseCliArgs(['pay', '--with', 'usdt-solana', 'pl_01ABC']);
  assert.equal(r.target, 'pl_01ABC');
});

test('everything after -- is positional', () => {
  const r = parseCliArgs(['pay', '--with', 'usdt-solana', '--', 'pl_01ABC']);
  assert.equal(r.target, 'pl_01ABC');
});
