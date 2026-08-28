/**
 * Caller provenance. The router records `client` as metadata.client, which is
 * the only server-side signal separating a scripted payment from a browser one
 * (both post to the same create-invoice endpoint). It is a reporting label: it
 * must always be sent, must never carry a key or identity, and must never be
 * able to fail a payment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { CLIENT_LABEL, createInvoice, MPP_BASE } from '../scripts/src/lib/api.mjs';

const pkg = createRequire(import.meta.url)('../package.json');

test('the client label names the CLI and its real published version', () => {
  assert.equal(CLIENT_LABEL, `rozo-checkout-cli/${pkg.version}`);
  // A 0.0.0 label means the package.json lookup silently fell back and every
  // order would be tagged with a version that does not exist.
  assert.notEqual(pkg.version, '0.0.0');
});

test('the label stays inside the charset the router keeps', () => {
  // The router strips anything outside [A-Za-z0-9._:/@+-]; a label that gets
  // rewritten server-side would no longer match what we query on.
  assert.match(CLIENT_LABEL, /^[A-Za-z0-9._:/@+-]+$/);
  assert.ok(CLIENT_LABEL.length <= 64, 'label must survive the 64-char cap');
});

test('createInvoice sends the client label on every order', async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, rozoPaymentId: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await createInvoice({
      url: 'https://payments.coinbase.com/payment-links/pl_test',
      source: { chainId: '900', tokenSymbol: 'USDT' },
    });
    await createInvoice({
      linkId: 'pl_test',
      source: { chainId: 'lightning', tokenSymbol: 'BTC' },
      quoteReceipt: 'r',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.url, `${MPP_BASE}/create-invoice`);
    assert.equal(call.body.client, CLIENT_LABEL);
  }
  // Provenance must not disturb the fields the payment actually depends on.
  assert.equal(seen[0].body.url, 'https://payments.coinbase.com/payment-links/pl_test');
  assert.equal(seen[1].body.payment_id, 'pl_test');
  assert.equal(seen[1].body.quoteReceipt, 'r');
  assert.deepEqual(seen[1].body.source, { chainId: 'lightning', tokenSymbol: 'BTC' });
});
