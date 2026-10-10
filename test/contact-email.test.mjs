/**
 * Optional contact email (--email) and the support channels.
 *
 * The email lets ROZO reach a payer whose order needs attention. It must stay
 * optional (absent means the create-invoice body is unchanged), be validated
 * before any order exists (a typo is an INVALID_EMAIL error, never a silent
 * drop), and never be echoed back in full.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInvoice, createBitrefillInvoice } from '../scripts/src/lib/api.mjs';
import { parseCliArgs, CliError, HELP } from '../scripts/src/lib/cli-args.mjs';
import {
  SUPPORT,
  SUPPORT_TEXT,
  normalizeContactEmail,
  contactEmailFromArgs,
  maskEmail,
  contactEmailAttached,
} from '../scripts/src/lib/support.mjs';
import { capture, emit, redact, redactDeep } from '../scripts/src/lib/output.mjs';
import { run as runCreateOrder } from '../scripts/src/create-order.mjs';
import { run as runCreateBitrefill } from '../scripts/src/create-bitrefill-order.mjs';

// The anonymous install_id / account_hash fields are covered in identity.test.mjs.
// Off here so these shape assertions stay exact and nothing is written to ~/.rozo-checkout.
process.env.ROZO_CHECKOUT_ANON_ID = 'off';

async function captureBodies(fn) {
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, rozoPaymentId: 'x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return bodies;
}

test('support channels are exactly the verified ones', () => {
  assert.deepEqual({ ...SUPPORT }, {
    email: 'hi@rozo.ai',
    x: 'https://x.com/ROZOai',
    discord: 'https://discord.gg/EfWejgTbuU',
  });
  for (const v of Object.values(SUPPORT)) assert.ok(SUPPORT_TEXT.includes(v), v);
  for (const v of Object.values(SUPPORT)) assert.ok(HELP.includes(v), v);
  assert.ok(HELP.includes('--email <addr>'));
});

test('normalizeContactEmail: absent/blank -> null, valid -> trimmed lowercase, bad -> undefined', () => {
  assert.equal(normalizeContactEmail(undefined), null);
  assert.equal(normalizeContactEmail(null), null);
  assert.equal(normalizeContactEmail('   '), null);
  assert.equal(normalizeContactEmail('  Alice.Pay@Example.COM '), 'alice.pay@example.com');
  for (const bad of ['nope', 'a@b', 'a b@x.com', '@x.com', 'a@@x.com', 'a@x.com\nBcc: y@z.com', 42, `${'a'.repeat(250)}@example.com`]) {
    assert.equal(normalizeContactEmail(bad), undefined, JSON.stringify(bad));
  }
});

test('an email can never be re-parsed as a control flag downstream', () => {
  for (const v of ['--confirm@x.com', '-a@x.com', '.a@x.com']) {
    assert.equal(normalizeContactEmail(v), undefined, v);
  }
});

test('--email parses on pay, normalized; absent leaves no key', () => {
  const pay = parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--email', ' You@Example.com ']);
  assert.equal(pay.email, 'you@example.com');
  const eq = parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--email=you@example.com']);
  assert.equal(eq.email, 'you@example.com');
  assert.equal('email' in parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana']), false);
  assert.equal('email' in parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--email=']), false);
});

test('an invalid --email is a clear INVALID_EMAIL error before any order exists', () => {
  for (const v of ['not-an-email', '--confirm@x.com', 'a@b']) {
    assert.throws(
      () => parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', `--email=${v}`]),
      (e) => e instanceof CliError && e.code === 'INVALID_EMAIL' && /optional/.test(e.message),
      v,
    );
  }
  assert.throws(
    () => parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--email']),
    (e) => e instanceof CliError && e.code === 'MISSING_VALUE',
  );
});

test('both create paths send email only when given', async () => {
  const src = { chainId: '900', tokenSymbol: 'USDT' };
  const bitrefill = { invoiceId: 'i', address: '0x' + '1'.repeat(40), amount: '1' };
  const bodies = await captureBodies(async () => {
    await createInvoice({ linkId: 'pl_test', source: src });
    await createInvoice({ linkId: 'pl_test', source: src, email: 'a@example.com' });
    await createBitrefillInvoice({ invoice: bitrefill, source: src });
    await createBitrefillInvoice({ invoice: bitrefill, source: src, email: 'a@example.com' });
  });
  assert.deepEqual(bodies.map((b) => b.email), [undefined, 'a@example.com', undefined, 'a@example.com']);
  assert.equal('email' in bodies[0], false);
  assert.equal('email' in bodies[2], false);
});

test('the order scripts reject a bad --email before any network call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('network must not be reached');
  };
  try {
    const a = await capture(() =>
      runCreateOrder(['--url', 'https://payments.coinbase.com/payment-links/pl_01test', '--chain', '900', '--token', 'USDT', '--email', 'bad']),
    );
    assert.equal(a.payload.success, false);
    assert.equal(a.payload.error.code, 'INVALID_EMAIL');
    const b = await capture(() =>
      runCreateBitrefill([
        '--invoice-id', 'inv1', '--to', '0x' + '1'.repeat(40), '--amount', '5',
        '--expires-at', new Date(Date.now() + 15 * 60_000).toISOString(),
        '--chain', '1500', '--token', 'USDC', '--email', 'bad',
      ]),
    );
    assert.equal(b.payload.success, false);
    assert.equal(b.payload.error.code, 'INVALID_EMAIL');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test('support links survive redaction; other URLs on those hosts do not', async () => {
  assert.deepEqual(redactDeep({ support: SUPPORT }), { support: { ...SUPPORT } });
  assert.equal(redact(SUPPORT_TEXT), SUPPORT_TEXT);
  assert.equal(redact('https://x.com/ROZOai/status/1?token=abc'), 'https://x.com/<redacted>');
  assert.equal(redact('https://discord.gg/other'), 'https://discord.gg/<redacted>');
  assert.equal(redact('https://discord.gg/EfWejgTbuUx'), 'https://discord.gg/<redacted>');
  // Through emit(), the path every JSON result takes.
  const r = await capture(() => emit({ success: true, support: SUPPORT }));
  assert.deepEqual(r.payload.support, { ...SUPPORT });
});

test('contactEmailAttached: only a new order with an email counts', () => {
  assert.equal(contactEmailAttached('a@example.com', false), true);
  assert.equal(contactEmailAttached('a@example.com', true), false);
  assert.equal(contactEmailAttached(null, false), false);
  assert.equal(contactEmailAttached(null, true), false);
});

test('contactEmailFromArgs and maskEmail', () => {
  assert.equal(contactEmailFromArgs({}), null);
  assert.equal(contactEmailFromArgs({ email: 'A@Example.com' }), 'a@example.com');
  assert.throws(() => contactEmailFromArgs({ email: true }), (e) => e.code === 'INVALID_EMAIL');
  assert.equal(maskEmail('alice@example.com'), 'a***@example.com');
});

test('bulk hint: one plain line, no emoji or dash, points at the docs page', async () => {
  const { BULK_HINT_TEXT, BULK_DOCS_URL } = await import('../scripts/src/lib/support.mjs');
  assert.equal(BULK_DOCS_URL, 'https://docs.rozo.ai/products/checkout/bulk-and-agents');
  assert.ok(BULK_HINT_TEXT.endsWith(BULK_DOCS_URL));
  assert.ok(!BULK_HINT_TEXT.includes('\n'));
  assert.ok(!/[–—]/.test(BULK_HINT_TEXT));
  assert.ok(!/\p{Extended_Pictographic}/u.test(BULK_HINT_TEXT));
});
