/**
 * End-to-end refusal tests against the REAL built scripts.
 *
 * These are the cases where a missing guard costs money, so they are exercised
 * through the same command line a user or agent would type. Every case here
 * aborts before any network call is made, so the suite stays offline.
 *
 * The key below is the all-zeros-but-one test key. It controls no funds; it
 * exists only so the script can derive an address before it refuses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DIST = path.join(ROOT, 'scripts', 'dist');

const BURNER_EVM_KEY = `0x${'0'.repeat(63)}1`;
// A 32-byte seed: any 32 bytes are a valid ed25519 seed, so this always
// derives a real (and empty) keypair.
const BURNER_SOL_KEY = JSON.stringify(Array.from({ length: 32 }, (_, i) => (i * 7) % 251));
const ID = '11111111-2222-4333-8444-555555555555';

function run(script, args, { stateDir, env = {} } = {}) {
  // HOME is redirected to an empty directory so the key-source layer can never
  // discover a real ~/.config/solana/id.json belonging to whoever runs the
  // suite. A test must never touch a developer's actual signing key.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-home-'));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(DIST, script), ...args],
      {
        cwd: os.tmpdir(), // a directory with no .env and no git repo
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          ROZO_CHECKOUT_STATE_DIR: stateDir,
          ROZO_CHECKOUT_EVM_KEY: BURNER_EVM_KEY,
          ROZO_CHECKOUT_SOL_KEY: BURNER_SOL_KEY,
          ...env,
        },
      },
      (err, stdout) => {
        fs.rmSync(fakeHome, { recursive: true, force: true });
        let json = null;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          json = null;
        }
        resolve({ exitCode: err ? err.code : 0, json, stdout: String(stdout) });
      },
    );
  });
}

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-entry-'));
}

async function seedOrder(stateDir, { confirmed = false } = {}) {
  const { createOrderRecord, recordConfirmation } = await import(
    `file://${path.join(ROOT, 'scripts', 'src', 'lib', 'state.mjs')}`
  );
  const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = stateDir;
  try {
    const source = {
      chainId: '8453',
      tokenSymbol: 'USDC',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      receiverAddress: '0x1111111111111111111111111111111111111111',
      receiverMemo: null,
      amount: '5.021000',
    };
    createOrderRecord({
      rozoPaymentId: ID,
      linkId: 'pl_01TESTTESTTESTTESTTEST',
      merchant: 'OpenRouter, Inc.',
      invoiceAmount: '5.000000',
      source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
      receiverAddress: source.receiverAddress,
      receiverMemo: null,
      amount: source.amount,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    if (confirmed) recordConfirmation(ID, { source, invoiceAmount: '5.000000' });
  } finally {
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;
  }
}

for (const script of ['send-evm.js', 'send-sol.js']) {
  test(`${script} refuses to move funds without --send`, async () => {
    const stateDir = tempStateDir();
    try {
      await seedOrder(stateDir, { confirmed: true });
      const res = await run(script, ['--rozo-payment-id', ID], { stateDir });
      assert.equal(res.json?.error?.code, 'SEND_NOT_OPTED_IN', res.stdout);
      assert.equal(res.json?.success, false);
      assert.notEqual(res.exitCode, 0, 'a refusal must exit non-zero');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test(`${script} refuses to send an unconfirmed order`, async () => {
    const stateDir = tempStateDir();
    try {
      await seedOrder(stateDir, { confirmed: false });
      const res = await run(script, ['--rozo-payment-id', ID, '--send'], { stateDir });
      assert.equal(res.json?.error?.code, 'NOT_CONFIRMED', res.stdout);
      assert.notEqual(res.exitCode, 0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test(`${script} refuses when no local order exists`, async () => {
    const stateDir = tempStateDir();
    try {
      const res = await run(script, ['--rozo-payment-id', ID, '--send'], { stateDir });
      assert.equal(res.json?.error?.code, 'NO_ORDER_STATE', res.stdout);
      assert.notEqual(res.exitCode, 0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test(`${script} refuses a second send even when confirmed`, async () => {
    const stateDir = tempStateDir();
    try {
      await seedOrder(stateDir, { confirmed: true });
      const { claimSend } = await import(
        `file://${path.join(ROOT, 'scripts', 'src', 'lib', 'state.mjs')}`
      );
      const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
      process.env.ROZO_CHECKOUT_STATE_DIR = stateDir;
      claimSend(ID, {
        chainId: '8453',
        tokenSymbol: 'USDC',
        from: '0x2222222222222222222222222222222222222222',
        to: '0x1111111111111111111111111111111111111111',
        amountAtomic: '5021000',
      });
      if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
      else process.env.ROZO_CHECKOUT_STATE_DIR = prev;

      const res = await run(script, ['--rozo-payment-id', ID, '--send'], { stateDir });
      assert.equal(res.json?.error?.code, 'ALREADY_SENT', res.stdout);
      assert.notEqual(res.exitCode, 0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test('the send scripts never echo the private key, in any error path', async () => {
  const stateDir = tempStateDir();
  try {
    const res = await run('send-evm.js', ['--rozo-payment-id', ID, '--send'], { stateDir });
    assert.ok(!res.stdout.includes(BURNER_EVM_KEY), 'the key must never appear in output');
    assert.ok(!res.stdout.includes(BURNER_EVM_KEY.slice(2)));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a malformed key is rejected without echoing it', async () => {
  const stateDir = tempStateDir();
  const bogus = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefEXTRA';
  try {
    const res = await run('send-evm.js', ['--rozo-payment-id', ID, '--send'], {
      stateDir,
      env: { ROZO_CHECKOUT_EVM_KEY: bogus },
    });
    assert.equal(res.json?.error?.code, 'BAD_KEY_FORMAT', res.stdout);
    assert.ok(!res.stdout.includes('deadbeef'));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('with no key anywhere, the error names the options and no value', async () => {
  const stateDir = tempStateDir();
  try {
    const res = await run('send-sol.js', ['--rozo-payment-id', ID, '--send'], {
      stateDir,
      env: { ROZO_CHECKOUT_SOL_KEY: '' },
    });
    // No keyfile, no ~/.config/solana/id.json (HOME is a temp dir), no env key.
    assert.equal(res.json?.error?.code, 'NO_KEY_SOURCE', res.stdout);
    assert.match(res.json.error.message, /solana-keygen/);
    assert.match(res.json.error.message, /--keyfile/);
    assert.match(res.json.error.message, /ROZO_CHECKOUT_SOL_KEY/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('scripts report usage errors as JSON with exit code 2', async () => {
  const stateDir = tempStateDir();
  try {
    const res = await run('quote.js', [], { stateDir });
    assert.equal(res.json?.error?.code, 'USAGE');
    assert.equal(res.exitCode, 2);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
