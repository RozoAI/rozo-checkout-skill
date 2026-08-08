import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkExpiry,
  parseDeadline,
  marginFor,
  MINUTE,
  BOLT11_MIN_VALIDITY_MS,
} from '../scripts/src/lib/expiry.mjs';

const NOW = Date.parse('2026-08-08T10:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

test('deadline parsing accepts ISO, ms epoch and second epoch', () => {
  assert.equal(parseDeadline('2026-08-08T10:00:00.000Z'), NOW);
  assert.equal(parseDeadline(NOW), NOW);
  assert.equal(parseDeadline(Math.floor(NOW / 1000)), NOW);
  assert.equal(parseDeadline(String(Math.floor(NOW / 1000))), NOW);
  assert.equal(parseDeadline('not-a-date'), null);
  assert.equal(parseDeadline(null), null);
  assert.equal(parseDeadline(''), null);
});

test('per-chain margins', () => {
  assert.equal(marginFor('900'), 5 * MINUTE);
  assert.equal(marginFor('8453'), 10 * MINUTE);
  assert.equal(marginFor('1500'), 10 * MINUTE);
  assert.equal(marginFor('lightning'), 10 * MINUTE);
  // Unknown chain falls back to the strictest documented margin, not to zero.
  assert.equal(marginFor('424242'), 10 * MINUTE);
});

test('passes with comfortable slack', () => {
  const r = checkExpiry({
    now: NOW,
    chainId: '900',
    intentExpiresAt: iso(60 * MINUTE),
    coinbaseExpiry: iso(120 * MINUTE),
  });
  assert.equal(r.ok, true);
  assert.equal(r.effectiveDeadlineMs, NOW + 60 * MINUTE);
  assert.equal(r.marginMs, 5 * MINUTE);
  assert.equal(r.msOfSlack, 55 * MINUTE);
});

test('the EARLIEST of the two deadlines governs', () => {
  const r = checkExpiry({
    now: NOW,
    chainId: '8453',
    intentExpiresAt: iso(120 * MINUTE),
    coinbaseExpiry: iso(12 * MINUTE),
  });
  assert.equal(r.effectiveDeadlineMs, NOW + 12 * MINUTE);
  assert.equal(r.ok, true);
  assert.equal(r.msOfSlack, 2 * MINUTE);
});

test('EXPIRY_MARGIN when inside the safety margin', () => {
  const r = checkExpiry({
    now: NOW,
    chainId: '8453',
    intentExpiresAt: iso(9 * MINUTE),
    coinbaseExpiry: iso(60 * MINUTE),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPIRY_MARGIN');
});

test('exactly at the margin boundary is refused (margin is inclusive)', () => {
  const r = checkExpiry({
    now: NOW,
    chainId: '900',
    intentExpiresAt: iso(5 * MINUTE),
    coinbaseExpiry: iso(60 * MINUTE),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPIRY_MARGIN');
});

test('Solana 5-minute margin is more permissive than the EVM 10-minute one', () => {
  const args = { now: NOW, intentExpiresAt: iso(7 * MINUTE), coinbaseExpiry: iso(60 * MINUTE) };
  assert.equal(checkExpiry({ ...args, chainId: '900' }).ok, true);
  assert.equal(checkExpiry({ ...args, chainId: '1' }).ok, false);
});

test('already-expired deadlines report EXPIRED', () => {
  const r = checkExpiry({
    now: NOW,
    chainId: '900',
    intentExpiresAt: iso(-1 * MINUTE),
    coinbaseExpiry: iso(60 * MINUTE),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPIRED');
});

test('missing or unparsable deadlines abort, never pass', () => {
  for (const bad of [null, undefined, '', 'soon']) {
    const a = checkExpiry({
      now: NOW,
      chainId: '900',
      intentExpiresAt: bad,
      coinbaseExpiry: iso(60 * MINUTE),
    });
    assert.equal(a.ok, false);
    assert.equal(a.code, 'EXPIRY_UNPARSABLE');

    const b = checkExpiry({
      now: NOW,
      chainId: '900',
      intentExpiresAt: iso(60 * MINUTE),
      coinbaseExpiry: bad,
    });
    assert.equal(b.ok, false);
    assert.equal(b.code, 'EXPIRY_UNPARSABLE');
  }
});

test('Lightning needs at least 10 minutes of BOLT11 validity on top of the margins', () => {
  const ok = checkExpiry({
    now: NOW,
    chainId: 'lightning',
    intentExpiresAt: iso(60 * MINUTE),
    coinbaseExpiry: iso(60 * MINUTE),
    bolt11ExpiresAt: iso(11 * MINUTE),
  });
  assert.equal(ok.ok, true);

  const tooShort = checkExpiry({
    now: NOW,
    chainId: 'lightning',
    intentExpiresAt: iso(60 * MINUTE),
    coinbaseExpiry: iso(60 * MINUTE),
    bolt11ExpiresAt: iso(BOLT11_MIN_VALIDITY_MS - MINUTE),
  });
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.code, 'BOLT11_TOO_SHORT');

  const unparsable = checkExpiry({
    now: NOW,
    chainId: 'lightning',
    intentExpiresAt: iso(60 * MINUTE),
    coinbaseExpiry: iso(60 * MINUTE),
    bolt11ExpiresAt: 'whenever',
  });
  assert.equal(unparsable.ok, false);
  assert.equal(unparsable.code, 'EXPIRY_UNPARSABLE');
});

test('formatRemaining renders a duration a payer can act on', async () => {
  const { formatRemaining } = await import('../scripts/src/lib/expiry.mjs');
  assert.equal(formatRemaining(47 * MINUTE), '47m');
  assert.equal(formatRemaining(MINUTE), '1m');
  assert.equal(formatRemaining(45 * 1000), '45s');
  assert.equal(formatRemaining(59 * 1000), '59s');
  assert.equal(formatRemaining(60 * MINUTE), '1h');
  assert.equal(formatRemaining(75 * MINUTE), '1h 15m');
  assert.equal(formatRemaining(2 * 60 * MINUTE), '2h');
  // Already gone, or unknowable.
  assert.equal(formatRemaining(0), 'expired');
  assert.equal(formatRemaining(-1), 'expired');
  assert.equal(formatRemaining(NaN), 'unknown');
  assert.equal(formatRemaining(undefined), 'unknown');
});
