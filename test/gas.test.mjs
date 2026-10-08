/**
 * Network-fee prechecks. Fake clients only: no RPC, no keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAtomic,
  evmFeeRequirement,
  assessFee,
  gasBufferPct,
  evmGasPrecheck,
  solFeePrecheck,
} from '../scripts/src/lib/gas.mjs';
import { redactDeep } from '../scripts/src/lib/output.mjs';

const FROM = '0x1234567890abcdef1234567890ABCDEF12345678';
const GWEI = 1_000_000_000n;

function evmClient({ balance = 10n ** 18n, gas = 50_000n, fees = { maxFeePerGas: 30n * GWEI }, failBalance, failEstimate } = {}) {
  return {
    async getBalance() {
      if (failBalance) throw new Error('rpc down https://rpc.example/secret-key-path');
      return balance;
    },
    async estimateGas() {
      if (failEstimate) throw new Error('insufficient funds for gas * price + value');
      return gas;
    },
    async estimateFeesPerGas() {
      return fees;
    },
  };
}

async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail(`expected ${code}`);
}

test('amounts are exact decimals from bigint, no floats', () => {
  assert.equal(formatAtomic(0n, 18), '0');
  assert.equal(formatAtomic(1n, 18), '0.000000000000000001');
  assert.equal(formatAtomic(1_500_000_000_000_000_000n, 18), '1.5');
  assert.equal(formatAtomic(5000n, 9), '0.000005');
});

test('fee requirement: 20% buffer rounds up, EIP-1559 preferred over legacy', () => {
  const r = evmFeeRequirement({ gasEstimate: 50_001n, maxFeePerGas: 10n, gasPrice: 999n });
  assert.equal(r.gasLimit, 60_002n); // ceil(50001 * 1.2)
  assert.equal(r.pricing, 'eip1559');
  assert.equal(r.fee, 600_020n);
  const legacy = evmFeeRequirement({ gasEstimate: 100n, gasPrice: 7n, bufferPct: 0 });
  assert.equal(legacy.pricing, 'legacy');
  assert.equal(legacy.fee, 700n);
  assert.equal(evmFeeRequirement({ gasEstimate: 100n }), null);
});

test('buffer is configurable within 0..200, else the default', () => {
  assert.equal(gasBufferPct({}), 20);
  assert.equal(gasBufferPct({ ROZO_CHECKOUT_GAS_BUFFER_PCT: '50' }), 50);
  for (const bad of ['-1', '201', '1.5', 'x']) assert.equal(gasBufferPct({ ROZO_CHECKOUT_GAS_BUFFER_PCT: bad }), 20);
});

test('assessFee reports balance, need and exact shortfall', () => {
  const a = assessFee({ balance: 1n, required: 3n, decimals: 0, symbol: 'ETH', network: 'Ethereum' });
  assert.equal(a.ok, false);
  assert.deepEqual(a.details, { network: 'Ethereum', feeCoin: 'ETH', balance: '1', required: '3', shortfall: '2' });
  assert.equal(assessFee({ balance: 3n, required: 3n, decimals: 0, symbol: 'ETH', network: 'x' }).ok, true);
});

test('EVM: zero ETH with USDC is INSUFFICIENT_GAS with network, coin and shortfall', async () => {
  const err = await rejectsWith(
    evmGasPrecheck({ client: evmClient({ balance: 0n }), chainId: 1, from: FROM, to: FROM, data: '0x' }),
    'INSUFFICIENT_GAS',
  );
  assert.equal(err.details.network, 'Ethereum');
  assert.equal(err.details.feeCoin, 'ETH');
  assert.equal(err.details.balance, '0');
  assert.equal(err.details.required, '0.0018'); // 60000 gas * 30 gwei
  assert.equal(err.details.shortfall, '0.0018');
  assert.match(err.message, /Nothing was signed/);
});

test('EVM: node refuses to estimate for a zero-balance sender, still INSUFFICIENT_GAS', async () => {
  const err = await rejectsWith(
    evmGasPrecheck({ client: evmClient({ balance: 0n, failEstimate: true }), chainId: 56, from: FROM, to: FROM, data: '0x' }),
    'INSUFFICIENT_GAS',
  );
  assert.equal(err.details.feeCoin, 'BNB');
  assert.equal(err.details.required, null);
});

test('EVM: RPC failure is GAS_CHECK_UNAVAILABLE, never a shortfall or a zero fee; URL redacted', async () => {
  const e1 = await rejectsWith(
    evmGasPrecheck({ client: evmClient({ failBalance: true }), chainId: 137, from: FROM, to: FROM, data: '0x' }),
    'GAS_CHECK_UNAVAILABLE',
  );
  assert.doesNotMatch(e1.message, /secret-key-path/);
  await rejectsWith(
    evmGasPrecheck({ client: evmClient({ balance: 5n, failEstimate: true }), chainId: 137, from: FROM, to: FROM, data: '0x' }),
    'GAS_CHECK_UNAVAILABLE',
  );
  await rejectsWith(
    evmGasPrecheck({ client: evmClient({ fees: {} }), chainId: 8453, from: FROM, to: FROM, data: '0x' }),
    'GAS_CHECK_UNAVAILABLE',
  );
});

test('EVM: enough native coin passes and reports the fee', async () => {
  const d = await evmGasPrecheck({ client: evmClient(), chainId: 8453, from: FROM, to: FROM, data: '0x', bufferPct: 20 });
  assert.equal(d.feeCoin, 'ETH');
  assert.equal(d.network, 'Base');
  assert.equal(d.gasLimit, '60000');
  assert.equal(d.pricing, 'eip1559');
  assert.equal(d.shortfall, null);
});

const LAMPORTS = 1_000_000_000n;
function solConn({ balance = LAMPORTS, fee = 5000, rent = 890_880, failFee } = {}) {
  return {
    async getBalance() {
      return Number(balance);
    },
    async getFeeForMessage() {
      if (failFee) throw new Error('rpc timeout');
      return { value: fee };
    },
    async getMinimumBalanceForRentExemption() {
      return rent;
    },
  };
}

test('Solana: zero SOL is INSUFFICIENT_GAS', async () => {
  const err = await rejectsWith(solFeePrecheck({ connection: solConn({ balance: 0n }), payer: 'p', message: {} }), 'INSUFFICIENT_GAS');
  assert.equal(err.details.feeCoin, 'SOL');
  assert.equal(err.details.balance, '0');
});

test('Solana: paying the fee to exactly zero is allowed; leaving dust under rent-exempt is not', async () => {
  const exact = await solFeePrecheck({ connection: solConn({ balance: 5000n }), payer: 'p', message: {} });
  assert.equal(exact.shortfall, null);
  const err = await rejectsWith(solFeePrecheck({ connection: solConn({ balance: 10_000n }), payer: 'p', message: {} }), 'INSUFFICIENT_GAS');
  assert.match(err.message, /minimum balance/);
  assert.equal(err.details.required, '0.00089588'); // 5000 fee + 890880 rent
});

test('Solana: no fee from the node is GAS_CHECK_UNAVAILABLE', async () => {
  await rejectsWith(solFeePrecheck({ connection: solConn({ fee: null }), payer: 'p', message: {} }), 'GAS_CHECK_UNAVAILABLE');
  await rejectsWith(solFeePrecheck({ connection: solConn({ failFee: true }), payer: 'p', message: {} }), 'GAS_CHECK_UNAVAILABLE');
});

test('Solana: plenty of SOL passes', async () => {
  const d = await solFeePrecheck({ connection: solConn(), payer: 'p', message: {} });
  assert.equal(d.fee, '0.000005');
  assert.equal(d.shortfall, null);
});

test('tx hashes survive redaction only under hash field names; keys never do', () => {
  const hex = `0x${'ab'.repeat(32)}`;
  const sig = '5'.repeat(88);
  const out = redactDeep({
    txHash: hex,
    signature: sig,
    nested: { payoutTxHash: hex, localSend: { txHash: hex } },
    privateKey: hex,
    secretKey: sig,
    note: `leaked ${hex}`,
    other: hex,
    txHashWithText: `${hex} extra`,
  });
  assert.equal(out.txHash, hex);
  assert.equal(out.signature, sig);
  assert.equal(out.nested.payoutTxHash, hex);
  assert.equal(out.nested.localSend.txHash, hex);
  assert.equal(out.privateKey, '<redacted>');
  assert.equal(out.secretKey, '<redacted>');
  assert.equal(out.note, 'leaked 0x<redacted>');
  assert.equal(out.other, '0x<redacted>');
  assert.equal(redactDeep({ txHash: `${hex} extra` }).txHash, '0x<redacted> extra');
});
