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
  recordConfirmation,
  depositDigest,
  findByLinkId,
  statePath,
  stateRoot,
  assertPaymentLimit,
  withLock,
  MAX_PAYMENT_USD,
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
    const { state: claimed } = claimSend(ID, INTENT);
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

test('the payment limit is a single hard ceiling at $1,100', () => {
  withTempStateDir(() => {
    assert.equal(MAX_PAYMENT_USD, 1100);

    // The case this limit was sized for: a $1,000 credit purchase plus its 5%
    // fee. It must pass.
    assert.doesNotThrow(() => assertPaymentLimit('1050'));
    assert.doesNotThrow(() => assertPaymentLimit('1050.00'));
    assert.deepEqual(assertPaymentLimit('1050'), { usd: 1050, limitUsd: 1100 });

    // Everyday amounts pass.
    for (const ok of ['0', '5.00', '99.99', '100', '250', '999.99']) {
      assert.doesNotThrow(() => assertPaymentLimit(ok), ok);
    }

    // The boundary itself is allowed; a cent over is not.
    assert.doesNotThrow(() => assertPaymentLimit('1100'));
    assert.doesNotThrow(() => assertPaymentLimit('1100.00'));
    assert.throws(() => assertPaymentLimit('1100.01'), (e) => e.code === 'CAP_PER_TX');
    assert.throws(() => assertPaymentLimit('1101'), (e) => e.code === 'CAP_PER_TX');
    assert.throws(() => assertPaymentLimit('5000'), (e) => e.code === 'CAP_PER_TX');
  });
});

test('the limit has no override and no session component', async () => {
  // There is exactly one rule. Nothing may re-enable an override.
  const mod = await import('../scripts/src/lib/state.mjs');
  assert.equal(mod.MAX_SESSION_USD, undefined, 'the session cap must be gone');
  assert.equal(mod.sessionSpendUsd, undefined, 'session accounting must be gone');
  assert.equal(mod.assertSpendCaps, undefined, 'the old caps API must be gone');

  // No option object can lift the ceiling.
  for (const opts of [{ allowLarge: true }, { yesLarge: true }, { force: true }]) {
    assert.throws(
      () => assertPaymentLimit('2000', opts),
      (e) => e.code === 'CAP_PER_TX',
      JSON.stringify(opts),
    );
  }

  // The refusal must point at the keyless path rather than at a flag.
  const err = (() => {
    try {
      assertPaymentLimit('2000');
    } catch (e) {
      return e;
    }
  })();
  assert.match(err.message, /no override/i);
  assert.doesNotMatch(err.message, /--yes-large/);
});

test('a bad amount is refused rather than treated as zero', () => {
  for (const bad of [undefined, null, '', 'abc', '-1', NaN]) {
    assert.throws(() => assertPaymentLimit(bad), (e) => e.code === 'BAD_INVOICE_AMOUNT', String(bad));
  }
});

test('claimSend enforces the limit from the recorded invoice amount', () => {
  withTempStateDir(() => {
    createOrderRecord({ ...ORDER, invoiceAmount: '1050' });
    assert.doesNotThrow(() => claimSend(ID, INTENT));
  });
  withTempStateDir(() => {
    const big = `2222222a-2222-4333-8444-555555555555`;
    createOrderRecord({ ...ORDER, rozoPaymentId: big, invoiceAmount: '1200' });
    assert.throws(() => claimSend(big, INTENT), (e) => e.code === 'CAP_PER_TX');
    // A refused claim must not leave a claim behind.
    assert.equal(readState(big).send, null);
  });
  withTempStateDir(() => {
    // Two separate large-but-legal payments both succeed: no session ceiling.
    for (const n of ['a', 'b', 'c']) {
      const id = `3333333${n}-2222-4333-8444-555555555555`;
      createOrderRecord({ ...ORDER, rozoPaymentId: id, invoiceAmount: '1000' });
      assert.doesNotThrow(() => claimSend(id, INTENT), `payment ${n}`);
    }
  });
});
