/**
 * Optional channel attribution (utm_source). A distribution channel can tag the
 * orders this CLI creates via ROZO_CHECKOUT_UTM_SOURCE or --utm-source. It is a
 * reporting label only: an invalid value must be dropped, never fail an order,
 * and an absent value must leave the attribution object exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ATTRIBUTION_CLIENT, buildAttribution, createInvoice, createBitrefillInvoice } from '../scripts/src/lib/api.mjs';
import { normalizeUtmSource } from '../scripts/src/lib/utm.mjs';
import { parseCliArgs, CliError } from '../scripts/src/lib/cli-args.mjs';

const ENV = 'ROZO_CHECKOUT_UTM_SOURCE';

function withEnv(value, fn) {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
}

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

test('env set -> utm_source present (trimmed, lowercased)', () => {
  withEnv('  Partner-Blog.v2 ', () => {
    assert.deepEqual(buildAttribution(), { client: ATTRIBUTION_CLIENT, utm_source: 'partner-blog.v2' });
  });
});

test('explicit flag value overrides the env', () => {
  withEnv('from-env', () => {
    assert.deepEqual(buildAttribution({ utmSource: 'from_flag' }), {
      client: ATTRIBUTION_CLIENT,
      utm_source: 'from_flag',
    });
  });
});

test('invalid chars, empty or too long -> utm_source omitted, never throws', () => {
  for (const bad of ['has space', 'a/b', 'email@x.com', 'x'.repeat(101), '', '   ', 'ünï']) {
    withEnv(bad, () => {
      assert.deepEqual(buildAttribution(), { client: ATTRIBUTION_CLIENT }, JSON.stringify(bad));
    });
    assert.equal(normalizeUtmSource(bad), null);
  }
  // An invalid explicit value is dropped, and does not fall back to the env.
  withEnv('from-env', () => {
    assert.deepEqual(buildAttribution({ utmSource: 'bad value' }), { client: ATTRIBUTION_CLIENT });
  });
  assert.equal(normalizeUtmSource('x'.repeat(100)), 'x'.repeat(100));
  assert.equal(normalizeUtmSource(42), null);
});

test('absent -> the utm_source key is not sent at all', () => {
  withEnv(undefined, () => {
    const a = buildAttribution();
    assert.deepEqual(a, { client: ATTRIBUTION_CLIENT });
    assert.equal('utm_source' in a, false);
  });
});

test('both create paths send utm_source from env, and the flag overrides it', async () => {
  const prev = process.env[ENV];
  process.env[ENV] = 'env-channel';
  let bodies;
  try {
    bodies = await captureBodies(async () => {
      await createInvoice({ linkId: 'pl_test', source: { chainId: '900', tokenSymbol: 'USDT' } });
      await createInvoice({ linkId: 'pl_test', source: { chainId: '900', tokenSymbol: 'USDT' }, utmSource: 'flag-channel' });
      await createBitrefillInvoice({
        invoice: { invoiceId: 'i', address: '0x' + '1'.repeat(40), amount: '1' },
        source: { chainId: '1500', tokenSymbol: 'USDC' },
      });
      await createBitrefillInvoice({
        invoice: { invoiceId: 'i', address: '0x' + '1'.repeat(40), amount: '1' },
        source: { chainId: '1500', tokenSymbol: 'USDC' },
        utmSource: 'flag-channel',
      });
    });
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
  assert.deepEqual(
    bodies.map((b) => b.attribution.utm_source),
    ['env-channel', 'flag-channel', 'env-channel', 'flag-channel'],
  );
  for (const b of bodies) assert.equal(b.attribution.client, ATTRIBUTION_CLIENT);
});

test('--utm-source parses on pay and quote, normalized', () => {
  const pay = parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--utm-source', ' Newsletter ']);
  assert.equal(pay.utmSource, 'newsletter');
  assert.equal(pay.source.chainId, '900');
  const quote = parseCliArgs(['quote', 'pl_x', '--utm-source=blog']);
  assert.equal(quote.utmSource, 'blog');
  assert.equal(quote.target, 'pl_x');
});

test('--utm-source absent leaves the descriptor without the key', () => {
  assert.equal('utmSource' in parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana']), false);
  assert.equal('utmSource' in parseCliArgs(['quote', 'pl_x']), false);
});

test('an invalid --utm-source is a usage error before any order exists', () => {
  assert.throws(
    () => parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--utm-source', 'a b']),
    (e) => e instanceof CliError && e.code === 'BAD_VALUE',
  );
  assert.throws(
    () => parseCliArgs(['pay', 'pl_x', '--with', 'usdt-solana', '--utm-source']),
    (e) => e instanceof CliError && e.code === 'MISSING_VALUE',
  );
});
