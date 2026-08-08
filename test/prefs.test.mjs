/**
 * Preference memory: the last wallet address and coin.
 *
 * Two properties matter beyond the round-trip: a corrupt file must degrade to
 * "no defaults" rather than crash a payment, and a remembered address that has
 * since been blacklisted must not flow through on reuse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { readPrefs, savePrefs, prefsPath, clearPrefs } = await import(
  '../scripts/src/lib/prefs.mjs'
);
const { checkAddress, loadBlacklist } = await import('../scripts/src/lib/blacklist.mjs');
const { detectAddressFamily } = await import('../scripts/src/lib/wallet-check.mjs');

const EVM = '0xdC4313EfB37836615d820F38A6016EE76598887B';

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-prefs-'));
  const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
  // prefs.json sits beside state/, so point the state dir inside our temp home.
  process.env.ROZO_CHECKOUT_STATE_DIR = path.join(dir, 'state');
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('preferences round-trip', () => {
  withTempHome(() => {
    assert.equal(readPrefs(), null, 'no file means no defaults');

    savePrefs({ lastPayerAddress: EVM, lastAddressFamily: 'evm', lastPreset: 'usdt-solana' });
    const p = readPrefs();
    assert.equal(p.lastPayerAddress, EVM);
    assert.equal(p.lastAddressFamily, 'evm');
    assert.equal(p.lastPreset, 'usdt-solana');
    assert.ok(Date.parse(p.updatedAt) > 0);

    // Written with restrictive permissions, like the state files.
    assert.equal(fs.statSync(prefsPath()).mode & 0o777, 0o600);
  });
});

test('saving merges rather than replacing', () => {
  withTempHome(() => {
    savePrefs({ lastPayerAddress: EVM, lastAddressFamily: 'evm', lastPreset: 'usdc-base' });
    savePrefs({ lastPreset: 'btc-lightning' });
    const p = readPrefs();
    assert.equal(p.lastPreset, 'btc-lightning');
    assert.equal(p.lastPayerAddress, EVM, 'the address must survive a coin-only update');
  });
});

test('only the allowed fields are ever persisted', () => {
  withTempHome(() => {
    savePrefs({
      lastPayerAddress: EVM,
      lastPreset: 'usdt-solana',
      // None of these may be written, now or by accident later.
      privateKey: '0xdeadbeef',
      balances: { usdc: 1000 },
      invoice: 'pl_01SECRET',
      rozoPaymentId: '11111111-2222-4333-8444-555555555555',
    });
    const raw = fs.readFileSync(prefsPath(), 'utf8');
    assert.ok(!raw.includes('deadbeef'));
    assert.ok(!raw.includes('balances'));
    assert.ok(!raw.includes('pl_01SECRET'));
    assert.ok(!raw.includes('rozoPaymentId'));
    assert.deepEqual(
      Object.keys(JSON.parse(raw)).sort(),
      ['lastPayerAddress', 'lastPreset', 'updatedAt'],
    );
  });
});

test('a corrupt or hostile prefs file degrades to no defaults', () => {
  withTempHome(() => {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
    for (const junk of ['{ truncated', '', 'null', '[]', '"a string"', '123']) {
      fs.writeFileSync(prefsPath(), junk);
      assert.equal(readPrefs(), null, JSON.stringify(junk));
    }
    // Right shape, wrong types: those fields are simply ignored.
    fs.writeFileSync(prefsPath(), JSON.stringify({ lastPayerAddress: 42, lastPreset: null }));
    assert.equal(readPrefs(), null);
    // A partially valid file yields only the valid parts.
    fs.writeFileSync(prefsPath(), JSON.stringify({ lastPreset: 'usdc-base', junk: true }));
    assert.deepEqual(readPrefs(), { lastPreset: 'usdc-base' });
  });
});

test('a remembered address is still checked against the blacklist on reuse', () => {
  withTempHome(() => {
    // A known-compromised address, saved before it was blacklisted.
    const compromised = '0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6';
    savePrefs({ lastPayerAddress: compromised, lastAddressFamily: 'evm' });

    const p = readPrefs();
    assert.equal(p.lastPayerAddress, compromised, 'it is stored like any other string');

    // But reuse must re-validate it, which is what the CLI does before use.
    const family = detectAddressFamily(p.lastPayerAddress);
    assert.equal(family, 'evm');
    const verdict = checkAddress(p.lastPayerAddress, family, loadBlacklist());
    assert.equal(verdict.hit, true, 'a later-blacklisted address must be caught on reuse');
  });
});

test('clearing removes the file, and reading after that is safe', () => {
  withTempHome(() => {
    savePrefs({ lastPreset: 'usdc-base' });
    assert.ok(readPrefs());
    assert.equal(clearPrefs(), true);
    assert.equal(readPrefs(), null);
    assert.equal(clearPrefs(), false, 'clearing twice is harmless');
  });
});
