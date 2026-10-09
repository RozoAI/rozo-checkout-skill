/**
 * Anonymous attribution: install_id persists across runs, account_hash is the
 * salted sha256 the router expects, and the raw OpenRouter key never leaves
 * the process (not in the request, not in the prefs file).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  attributionIdentity,
  getOrCreateInstallId,
  hashAccount,
  INSTALL_ID_RE,
  ACCOUNT_HASH_RE,
} from '../scripts/src/lib/identity.mjs';
import { prefsPath, readPrefs, savePrefs } from '../scripts/src/lib/prefs.mjs';
import { createInvoice, createBitrefillInvoice, buildAttribution, ATTRIBUTION_CLIENT } from '../scripts/src/lib/api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Shaped like a real key, never a real one.
const FAKE_KEY = `sk-or-v1-${'f'.repeat(64)}`;
const ENV_KEYS = ['ROZO_CHECKOUT_STATE_DIR', 'ROZO_CHECKOUT_ANON_ID', 'OPENROUTER_API_KEY', 'ROZO_CHECKOUT_OPENROUTER_ACCOUNT_ID', 'ROZO_CHECKOUT_UTM_SOURCE'];

async function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-identity-'));
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ROZO_CHECKOUT_STATE_DIR = path.join(dir, 'state');
  try {
    return await fn(dir);
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install_id is a v4 UUID, created once and stable across runs', async () => {
  await withTempHome(() => {
    const a = getOrCreateInstallId();
    assert.match(a, INSTALL_ID_RE);
    assert.equal(getOrCreateInstallId(), a);
    assert.equal(readPrefs().installId, a);
    assert.equal(fs.statSync(prefsPath()).mode & 0o777, 0o600);

    // Unrelated preference writes must not clobber it.
    savePrefs({ lastPreset: 'usdt-solana' });
    assert.equal(getOrCreateInstallId(), a);
    // Nor can an ordinary caller overwrite it.
    savePrefs({ installId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(readPrefs().installId, a);
  });
});

test('install_id is the same in two separate processes (real persistence)', async () => {
  await withTempHome(() => {
    const script = `import { getOrCreateInstallId } from ${JSON.stringify(path.join(here, '../scripts/src/lib/identity.mjs'))}; process.stdout.write(getOrCreateInstallId());`;
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env }).toString();
    const first = run();
    const second = run();
    assert.match(first, INSTALL_ID_RE);
    assert.equal(second, first);
  });
});

test('deleting prefs.json resets the id; a corrupt value is replaced', async () => {
  await withTempHome(() => {
    const a = getOrCreateInstallId();
    fs.unlinkSync(prefsPath());
    const b = getOrCreateInstallId();
    assert.match(b, INSTALL_ID_RE);
    assert.notEqual(b, a);

    fs.writeFileSync(prefsPath(), JSON.stringify({ installId: 'not-a-uuid' }));
    const c = getOrCreateInstallId();
    assert.match(c, INSTALL_ID_RE);
  });
});

test('account_hash is lowercase hex sha256 of the prefixed identifier', () => {
  const h = hashAccount(FAKE_KEY);
  assert.match(h, ACCOUNT_HASH_RE);
  assert.equal(h, crypto.createHash('sha256').update(`rozo-acct-v1:${FAKE_KEY}`).digest('hex'));
  assert.notEqual(h, crypto.createHash('sha256').update(FAKE_KEY).digest('hex'), 'must be salted');
});

test('account_hash comes only from the API key, never from an account id', async () => {
  await withTempHome(() => {
    assert.equal(attributionIdentity().account_hash, undefined);
    // A low-entropy account id alone must not produce a (reversible) hash.
    process.env.ROZO_CHECKOUT_OPENROUTER_ACCOUNT_ID = 'acct_123';
    assert.equal(attributionIdentity().account_hash, undefined);
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    assert.equal(attributionIdentity().account_hash, hashAccount(FAKE_KEY));
  });
});

test('ROZO_CHECKOUT_ANON_ID=off sends neither field and writes nothing', async () => {
  await withTempHome(() => {
    process.env.ROZO_CHECKOUT_ANON_ID = 'off';
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    assert.deepEqual(attributionIdentity(), {});
    assert.deepEqual(buildAttribution(), { client: ATTRIBUTION_CLIENT });
    assert.equal(fs.existsSync(prefsPath()), false);
  });
});

test('create-invoice carries install_id + account_hash and never the raw key', async () => {
  await withTempHome(async () => {
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    const bodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ ok: true, rozoPaymentId: 'x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      await createInvoice({ linkId: 'pl_test', source: { chainId: '900', tokenSymbol: 'USDT' } });
      await createInvoice({ linkId: 'pl_test', source: { chainId: '900', tokenSymbol: 'USDT' } });
      await createBitrefillInvoice({
        invoice: { invoiceId: 'b', address: '0x0000000000000000000000000000000000000001', amount: '1' },
        source: { chainId: '900', tokenSymbol: 'USDT' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const id = readPrefs().installId;
    assert.match(id, INSTALL_ID_RE);
    for (const raw of bodies) {
      assert.ok(!raw.includes(FAKE_KEY), 'raw key leaked into the request body');
      assert.ok(!raw.includes('sk-or-'), 'key prefix leaked into the request body');
      const body = JSON.parse(raw);
      assert.equal(body.attribution.client, ATTRIBUTION_CLIENT);
      assert.equal(body.attribution.install_id, id, 'same id on every order');
      assert.equal(body.attribution.account_hash, hashAccount(FAKE_KEY));
    }
    // Nor is the key ever persisted.
    assert.ok(!fs.readFileSync(prefsPath(), 'utf8').includes(FAKE_KEY));
  });
});
