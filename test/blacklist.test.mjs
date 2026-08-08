import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  normalizeAddress,
  parseBlacklist,
  loadBlacklist,
  checkAddress,
  assertNotBlacklisted,
} from '../scripts/src/lib/blacklist.mjs';

function signed(entries, overrides = {}) {
  const addresses = entries.map((e) => e.address);
  return {
    provenance: {
      source: 'test',
      syncedOn: '2026-08-08',
      addressCount: entries.length,
      addressesSha256: crypto
        .createHash('sha256')
        .update(JSON.stringify(addresses), 'utf8')
        .digest('hex'),
      ...overrides,
    },
    entries,
  };
}

const EVM = { address: '0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6', family: 'evm', reportedOn: '2026-06-26', note: 'x' };
const SOL = { address: '9Ms2FNXMY9ucKwzxcnGxvqMcfSkBhRdPZhrsj1Ui1KiN', family: 'solana', reportedOn: '2026-06-26', note: 'x' };

test('EVM addresses normalize case-insensitively, base58/base32 do not', () => {
  assert.equal(
    normalizeAddress('0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6', 'evm'),
    '0xf621ee3bae3cbe924ec05f795d14e31384bd11b6',
  );
  // Detected as EVM even when the family is mislabelled.
  assert.equal(
    normalizeAddress('0xF621Ee3BaE3cbE924Ec05f795d14E31384Bd11b6', 'solana'),
    '0xf621ee3bae3cbe924ec05f795d14e31384bd11b6',
  );
  // Solana / Stellar are case-sensitive; lowercasing them would be wrong.
  assert.equal(normalizeAddress(SOL.address, 'solana'), SOL.address);
  assert.equal(normalizeAddress('  0xAbC  ', 'evm'), '0xabc');
  assert.equal(normalizeAddress('', 'evm'), null);
  assert.equal(normalizeAddress(null, 'evm'), null);
});

test('a hit is found regardless of the caller supplying a different case', () => {
  const bl = parseBlacklist(signed([EVM, SOL]));
  assert.equal(checkAddress(EVM.address.toUpperCase().replace('0X', '0x'), 'evm', bl).hit, true);
  assert.equal(checkAddress(EVM.address.toLowerCase(), 'evm', bl).hit, true);
  assert.equal(checkAddress(SOL.address, 'solana', bl).hit, true);
  // A Solana address differing only by case is a DIFFERENT address.
  assert.equal(checkAddress(SOL.address.toLowerCase(), 'solana', bl).hit, false);
  assert.equal(
    checkAddress('0x0000000000000000000000000000000000000001', 'evm', bl).hit,
    false,
  );
});

test('fails closed on every malformed document shape', () => {
  const bad = [
    null,
    undefined,
    [],
    'string',
    {},
    { entries: [EVM] }, // no provenance
    { provenance: {}, entries: [EVM] }, // no digest
    signed([]), // empty list
    { ...signed([EVM]), entries: [] },
  ];
  for (const doc of bad) {
    assert.throws(
      () => parseBlacklist(doc),
      (e) => e.code === 'BLACKLIST_UNAVAILABLE',
      `expected refusal for ${JSON.stringify(doc)}`,
    );
  }
});

test('fails closed when the address list was edited without re-signing', () => {
  const doc = signed([EVM, SOL]);
  doc.entries.pop(); // silently remove a compromised address
  assert.throws(() => parseBlacklist(doc), (e) => e.code === 'BLACKLIST_UNAVAILABLE');

  const doc2 = signed([EVM]);
  doc2.entries[0] = { ...EVM, address: '0x0000000000000000000000000000000000000009' };
  assert.throws(() => parseBlacklist(doc2), (e) => e.code === 'BLACKLIST_UNAVAILABLE');

  const doc3 = signed([EVM], { addressCount: 99 });
  assert.throws(() => parseBlacklist(doc3), (e) => e.code === 'BLACKLIST_UNAVAILABLE');
});

test('fails closed when the file is missing or is not JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-bl-'));
  assert.throws(
    () => loadBlacklist(path.join(dir, 'nope.json')),
    (e) => e.code === 'BLACKLIST_UNAVAILABLE',
  );
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  assert.throws(() => loadBlacklist(broken), (e) => e.code === 'BLACKLIST_UNAVAILABLE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNotBlacklisted throws BLACKLIST_HIT and names the role', () => {
  const bl = parseBlacklist(signed([EVM, SOL]));
  assert.doesNotThrow(() =>
    assertNotBlacklisted(
      [{ address: '0x0000000000000000000000000000000000000001', family: 'evm', role: 'deposit address' }],
      bl,
    ),
  );
  assert.throws(
    () => assertNotBlacklisted([{ address: EVM.address, family: 'evm', role: 'deposit address' }], bl),
    (e) => e.code === 'BLACKLIST_HIT' && e.role === 'deposit address',
  );
  // The sender is checked too, not just the destination.
  assert.throws(
    () =>
      assertNotBlacklisted(
        [
          { address: '0x0000000000000000000000000000000000000001', family: 'evm', role: 'deposit address' },
          { address: SOL.address, family: 'solana', role: 'sender wallet' },
        ],
        bl,
      ),
    (e) => e.code === 'BLACKLIST_HIT' && e.role === 'sender wallet',
  );
});

test('the vendored list loads, self-verifies, and contains known entries', () => {
  const bl = loadBlacklist();
  assert.ok(bl.entries.length >= 18);
  assert.equal(bl.digest, bl.provenance.addressesSha256);
  assert.equal(typeof bl.provenance.syncedOn, 'string');
  assert.ok(checkAddress(EVM.address, 'evm', bl).hit, 'known attacker address must be listed');
  assert.ok(checkAddress(SOL.address, 'solana', bl).hit);
});
