import test from 'node:test';
import assert from 'node:assert/strict';

import { statusGuidance } from '../scripts/src/status.mjs';

const base = { authoritativeView: true, escalate: false, unknown: false };

test('expired_unfunded on a Coinbase link: never advise a fresh order on the same link', () => {
  const g = statusGuidance({ ...base, state: 'expired_unfunded', terminal: true, provider: 'coinbase' });
  assert.match(g, /cannot be paid again/);
  assert.match(g, /LINK_USED_OR_EXPIRED/);
  assert.match(g, /new payment link from the merchant/);
  assert.match(g, /check your own wallet/);
  assert.match(g, /linkId and rozoPaymentId/);
  assert.doesNotMatch(g, /Start a fresh order/);
  assert.doesNotMatch(g, /rozo-checkout pay <coinbase-link>/);
  assert.doesNotMatch(g, /[–—]/);
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
