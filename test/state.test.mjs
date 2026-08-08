import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID = '11111111-2222-4333-8444-555555555555';

function withTempStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-state-'));
  const prev = process.env.ROZO_CHECKOUT_STATE_DIR;
  process.env.ROZO_CHECKOUT_STATE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.ROZO_CHECKOUT_STATE_DIR;
    else process.env.ROZO_CHECKOUT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Imported after the env-var helper so each test controls its own directory.
const {
  createOrderRecord,
  readState,
  claimSend,
  recordSendResult,
  statePath,
  assertSpendCaps,
  MAX_TX_USD,
} = await import('../scripts/src/lib/state.mjs');

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

test('order record round-trips and leaves no temp files behind', () => {
  withTempStateDir((dir) => {
    createOrderRecord(ORDER);
    const state = readState(ID);
    assert.equal(state.rozoPaymentId, ID);
    assert.equal(state.receiverAddress, ORDER.receiverAddress);
    assert.equal(state.send, null);
    assert.deepEqual(fs.readdirSync(dir), [`${ID}.json`]);
    // Written with restrictive permissions.
    const mode = fs.statSync(statePath(ID)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('re-creating the same order preserves createdAt and any send record', () => {
  withTempStateDir(() => {
    const first = createOrderRecord(ORDER);
    claimSend(ID, INTENT);
    const again = createOrderRecord({ ...ORDER, merchant: 'Renamed' });
    assert.equal(again.createdAt, first.createdAt);
    assert.equal(again.merchant, 'Renamed');
    assert.ok(again.send, 'a prior send record must survive a re-create');
  });
});

test('a second send for the same order is refused with ALREADY_SENT', () => {
  withTempStateDir(() => {
    createOrderRecord(ORDER);
    const claimed = claimSend(ID, INTENT);
    assert.equal(claimed.send.status, 'claimed');
    assert.throws(() => claimSend(ID, INTENT), (e) => e.code === 'ALREADY_SENT');

    // Still refused after the broadcast resolves, in every outcome.
    for (const status of ['submitted', 'confirmed', 'ambiguous', 'failed']) {
      recordSendResult(ID, { status, txHash: '0xdeadbeef' });
      assert.throws(() => claimSend(ID, INTENT), (e) => e.code === 'ALREADY_SENT');
    }
  });
});

test('sending without a created order is refused', () => {
  withTempStateDir(() => {
    assert.throws(() => claimSend(ID, INTENT), (e) => e.code === 'NO_ORDER_STATE');
  });
});

test('a corrupt state file is never read as "no send has happened"', () => {
  withTempStateDir(() => {
    createOrderRecord(ORDER);
    fs.writeFileSync(statePath(ID), '{ truncated');
    assert.throws(() => readState(ID), (e) => e.code === 'STATE_CORRUPT');
    assert.throws(() => claimSend(ID, INTENT), (e) => e.code === 'STATE_CORRUPT');
  });
});

test('state paths cannot be built from hostile ids', () => {
  withTempStateDir(() => {
    for (const bad of ['../../etc/passwd', 'a/b', '', 'short']) {
      assert.throws(() => statePath(bad), (e) => e.code === 'BAD_ROZO_PAYMENT_ID');
    }
  });
});

test('spend caps: per transaction and per session', () => {
  withTempStateDir(() => {
    assert.doesNotThrow(() => assertSpendCaps('5.00'));
    assert.throws(() => assertSpendCaps(String(MAX_TX_USD + 1)), (e) => e.code === 'CAP_PER_TX');
    assert.doesNotThrow(() => assertSpendCaps(String(MAX_TX_USD + 1), { allowLarge: true }));

    // Two claimed sends of $90 each put the session over the $200 ceiling.
    for (const [i, amount] of [['a', '90'], ['b', '90']]) {
      const id = `1111111${i === 'a' ? 'a' : 'b'}-2222-4333-8444-555555555555`;
      createOrderRecord({ ...ORDER, rozoPaymentId: id, invoiceAmount: amount });
      claimSend(id, INTENT);
    }
    assert.throws(() => assertSpendCaps('90'), (e) => e.code === 'CAP_SESSION');
    assert.doesNotThrow(() => assertSpendCaps('5'));
  });
});
