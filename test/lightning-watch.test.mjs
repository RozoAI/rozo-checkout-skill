/**
 * Lightning watch window: without --timeout, a Lightning order is watched for
 * as long as its invoice can still be paid (capped at 60 minutes); explicit
 * --timeout always wins; every other coin keeps its fixed default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  lightningWatchMs,
  minutesRemaining,
  settlementWatchSeconds,
  LIGHTNING_WATCH_CAP_MS,
  DEFAULT_WATCH_MS,
} from '../scripts/src/lib/expiry.mjs';
import { watchTimeoutMs } from '../scripts/src/status.mjs';

const NOW = Date.parse('2026-10-10T00:00:00Z');
const at = (min) => new Date(NOW + min * 60_000).toISOString();
// Orders whose invoice/intent expires `min` minutes from NOW (null = unknown).
const ln = (min) => ({ payin: { chain: 'Bitcoin Lightning' }, expiry: { expiresAt: min === null ? null : at(min) } });
const usdt = (min) => ({ payin: { chain: 'Solana' }, expiry: { expiresAt: at(min) } });

test('lightningWatchMs: remaining validity, capped, with fallbacks', () => {
  assert.equal(lightningWatchMs(at(25), { now: NOW }), 25 * 60_000);
  assert.equal(lightningWatchMs(at(240), { now: NOW }), LIGHTNING_WATCH_CAP_MS);
  assert.equal(lightningWatchMs(at(-1), { now: NOW }), DEFAULT_WATCH_MS);
  assert.equal(lightningWatchMs(null, { now: NOW }), DEFAULT_WATCH_MS);
  assert.equal(lightningWatchMs('garbage', { now: NOW, fallbackMs: 5 }), 5);
});

test('minutesRemaining floors, clamps at 0, null when unknown', () => {
  assert.equal(minutesRemaining(at(37.9), NOW), 37);
  assert.equal(minutesRemaining(at(-5), NOW), 0);
  assert.equal(minutesRemaining(undefined, NOW), null);
});

test('status --watch default: Lightning follows the invoice, others stay 600s', () => {
  assert.equal(watchTimeoutMs(undefined, ln(42), NOW), 42 * 60_000);
  assert.equal(watchTimeoutMs(undefined, ln(90), NOW), 60 * 60_000);
  assert.equal(watchTimeoutMs(undefined, ln(null), NOW), 600_000);
  assert.equal(watchTimeoutMs(undefined, usdt(42), NOW), 600_000);
});

test('status --timeout <s> always overrides, including for Lightning', () => {
  assert.equal(watchTimeoutMs('30', ln(42), NOW), 30_000);
  assert.equal(watchTimeoutMs(0, ln(42), NOW), 0);
  assert.equal(watchTimeoutMs('900', usdt(42), NOW), 900_000);
});

test('pay settlement watch: Lightning default is the invoice validity, explicit wins', () => {
  const lnDeposit = { lnInvoice: 'lnbc1...', expiresAt: at(35) };
  assert.equal(settlementWatchSeconds({ timeout: 900, timeoutExplicit: false }, lnDeposit, NOW), 35 * 60);
  assert.equal(settlementWatchSeconds({ timeout: 120, timeoutExplicit: true }, lnDeposit, NOW), 120);
  assert.equal(
    settlementWatchSeconds({ timeout: 900, timeoutExplicit: false }, { lnInvoice: 'lnbc1', expiresAt: at(500) }, NOW),
    3600,
  );
  // Non-Lightning keeps the pay default.
  assert.equal(
    settlementWatchSeconds({ timeout: 900, timeoutExplicit: false }, { receiverAddress: 'x', expiresAt: at(35) }, NOW),
    900,
  );
});
