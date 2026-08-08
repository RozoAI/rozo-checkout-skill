/**
 * Concurrency tests for the send-once rail.
 *
 * The dangerous failure is not a torn file — atomic rename already prevents
 * that — it is two PROCESSES both reading `send == null` and both broadcasting.
 * These tests spawn real child processes against a shared state directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_LIB = path.join(here, '..', 'scripts', 'src', 'lib', 'state.mjs');
const ID = '11111111-2222-4333-8444-555555555555';

const ORDER = {
  rozoPaymentId: ID,
  linkId: 'pl_01TESTTESTTESTTESTTEST',
  merchant: 'OpenRouter, Inc.',
  invoiceAmount: '5.000000',
  source: { chainId: '900', tokenSymbol: 'USDT' },
  receiverAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  receiverMemo: 'rozo-901',
  amount: '5.021000',
  expiresAt: '2026-08-08T11:00:00.000Z',
};

const INTENT = {
  chainId: '900',
  tokenSymbol: 'USDT',
  from: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  to: ORDER.receiverAddress,
  amountAtomic: '5021000',
};

function runNode(source, stateDir) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', source],
      { env: { ...process.env, ROZO_CHECKOUT_STATE_DIR: stateDir } },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-conc-'));
}

const libUrl = JSON.stringify(new URL(`file://${STATE_LIB}`).href);

test('two concurrent processes cannot both claim the same order', async () => {
  const dir = tempDir();
  try {
    const { createOrderRecord } = await import(`file://${STATE_LIB}`);
    const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
    process.env.ROZO_CHECKOUT_STATE_DIR = dir;
    createOrderRecord(ORDER);
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;

    const child = `
      import { claimSend } from ${libUrl};
      try {
        claimSend(${JSON.stringify(ID)}, ${JSON.stringify(INTENT)});
        console.log("CLAIMED");
      } catch (e) {
        console.log("REFUSED:" + e.code);
      }
    `;

    // Eight racers, all starting at once, against one order.
    const results = await Promise.all(Array.from({ length: 8 }, () => runNode(child, dir)));
    const claimed = results.filter((r) => r.stdout.includes('CLAIMED'));
    const refused = results.filter((r) => r.stdout.includes('REFUSED'));

    assert.equal(claimed.length, 1, `exactly one claim must win, got ${claimed.length}`);
    assert.equal(refused.length, 7);
    for (const r of refused) {
      assert.match(r.stdout, /REFUSED:(ALREADY_SENT|LOCK_TIMEOUT)/);
    }

    // And the persisted state reflects exactly one claim.
    const state = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8'));
    assert.equal(state.send.status, 'claimed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a concurrent re-create or re-confirm can never erase a send claim', async () => {
  // The dangerous interleaving: a writer reads the pre-claim state, a claim
  // lands, and the writer then writes its stale copy back — losing the claim
  // and reopening double-send. Every writer must therefore hold the lock.
  const dir = tempDir();
  try {
    const { createOrderRecord } = await import(`file://${STATE_LIB}`);
    const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
    process.env.ROZO_CHECKOUT_STATE_DIR = dir;
    createOrderRecord(ORDER);
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;

    const SOURCE = {
      chainId: '900',
      tokenSymbol: 'USDT',
      receiverAddress: ORDER.receiverAddress,
      receiverMemo: ORDER.receiverMemo,
      amount: ORDER.amount,
    };

    const claimer = `
      import { claimSend } from ${libUrl};
      try {
        claimSend(${JSON.stringify(ID)}, ${JSON.stringify(INTENT)});
        console.log("CLAIMED");
      } catch (e) { console.log("REFUSED:" + e.code); }
    `;
    // Hammer the same file with the other two writers while the claim lands.
    const rewriter = `
      import { createOrderRecord, recordConfirmation } from ${libUrl};
      for (let i = 0; i < 40; i++) {
        try { createOrderRecord(${JSON.stringify(ORDER)}); } catch {}
        try {
          recordConfirmation(${JSON.stringify(ID)}, { source: ${JSON.stringify(SOURCE)} });
        } catch {}
      }
      console.log("REWROTE");
    `;

    const results = await Promise.all([
      runNode(rewriter, dir),
      runNode(claimer, dir),
      runNode(rewriter, dir),
      runNode(rewriter, dir),
    ]);
    assert.ok(results[1].stdout.includes('CLAIMED'), results[1].stdout + results[1].stderr);

    const state = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8'));
    assert.ok(state.send, 'the send claim must survive concurrent re-create/re-confirm');
    assert.equal(state.send.status, 'claimed');
    assert.equal(state.send.amountAtomic, INTENT.amountAtomic);

    // And a later claim still sees it, so a second send stays impossible.
    const second = await runNode(claimer, dir);
    assert.match(second.stdout, /REFUSED:ALREADY_SENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent claims on different orders all succeed: there is no session cap', async () => {
  const dir = tempDir();
  try {
    const { createOrderRecord } = await import(`file://${STATE_LIB}`);
    const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
    process.env.ROZO_CHECKOUT_STATE_DIR = dir;

    // Five separate $1,000 payments. Each is under the single $1,100 limit, so
    // every one must be allowed no matter how they interleave — the old
    // cumulative ceiling is gone by design.
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = `6666666${i}-2222-4333-8444-555555555555`;
      ids.push(id);
      createOrderRecord({ ...ORDER, rozoPaymentId: id, invoiceAmount: '1000' });
    }
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;

    const results = await Promise.all(
      ids.map((id) =>
        runNode(
          `
          import { claimSend } from ${libUrl};
          try {
            claimSend(${JSON.stringify(id)}, ${JSON.stringify(INTENT)});
            console.log("CLAIMED");
          } catch (e) {
            console.log("REFUSED:" + e.code);
          }
        `,
          dir,
        ),
      ),
    );

    const claimed = results.filter((r) => r.stdout.includes('CLAIMED')).length;
    assert.equal(claimed, 5, 'every payment under the single limit must be allowed');

    // But an order above the limit is still refused, even concurrently.
    const bigId = '7777777a-2222-4333-8444-555555555555';
    process.env.ROZO_CHECKOUT_STATE_DIR = dir;
    createOrderRecord({ ...ORDER, rozoPaymentId: bigId, invoiceAmount: '1200' });
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;

    const refused = await Promise.all(
      [0, 1, 2].map(() =>
        runNode(
          `
          import { claimSend } from ${libUrl};
          try {
            claimSend(${JSON.stringify(bigId)}, ${JSON.stringify(INTENT)});
            console.log("CLAIMED");
          } catch (e) { console.log("REFUSED:" + e.code); }
        `,
          dir,
        ),
      ),
    );
    for (const r of refused) assert.match(r.stdout, /REFUSED:CAP_PER_TX/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
