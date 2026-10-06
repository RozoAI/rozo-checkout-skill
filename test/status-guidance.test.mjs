import test from 'node:test';
import assert from 'node:assert/strict';

import { statusGuidance } from '../scripts/src/status.mjs';

const base = { authoritativeView: true, escalate: false, unknown: false };

test('expired_unfunded on a Coinbase link: wallet check first, then re-pay the same link', () => {
  const g = statusGuidance({ ...base, state: 'expired_unfunded', terminal: true, provider: 'coinbase' });
  // The wallet check must come before any advice to pay again.
  assert.match(g, /check your own wallet/);
  assert.ok(g.indexOf('check your own wallet') < g.indexOf('re-run the same pay'));
  assert.match(g, /Lightning payment is still pending/);
  assert.match(g, /linkId and rozoPaymentId/);
  assert.match(g, /re-run the same pay on the same link with the same --with/);
  assert.match(g, /PAYMENT_EXPIRED with retryable: true.*wait a few minutes and retry/);
  assert.match(g, /LINK_USED_OR_EXPIRED, or PAYMENT_EXPIRED with confirmed: true.*new payment link from the merchant/);
  assert.match(g, /ORDER_ALREADY_ACTIVE.*do not pay again/);
  assert.doesNotMatch(g, /cannot be paid again: re-running/);
  assert.doesNotMatch(g, /nothing was lost/);
  assert.doesNotMatch(g, /[\u2013\u2014]/);
});

test('expired Bitrefill order still points at a fresh Bitrefill invoice', () => {
  for (const state of ['expired_unfunded', 'invoice_expired']) {
    const g = statusGuidance({ ...base, state, terminal: true, provider: 'bitrefill' });
    assert.match(g, /fresh Bitrefill invoice/);
  }
});

test('other guidance branches are unchanged', () => {
  assert.match(statusGuidance({ ...base, escalate: true }), /MONEY DETECTED/);
  assert.match(statusGuidance({ ...base, unknown: true }), /could not be established/);
  assert.match(statusGuidance({ ...base, authoritativeView: false }), /fulfilment view/);
  assert.equal(statusGuidance({ ...base, state: 'settled', terminal: true }), 'Done.');
  assert.match(statusGuidance({ ...base, state: 'bridging', terminal: false }), /Still in flight/);
});
