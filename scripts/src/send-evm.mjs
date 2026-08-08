#!/usr/bin/env node
/**
 * send-evm.js — Mode B, EVM chains only (Ethereum, BNB Chain, Polygon, Base).
 *
 *   ROZO_CHECKOUT_EVM_KEY=0x... node scripts/dist/send-evm.js --rozo-payment-id <uuid>
 *
 * This is the only EVM code path that moves money, and it only runs when the
 * caller asked for it explicitly. It:
 *   - reads the key from the environment only, never argv, never prints it
 *   - re-runs every live check (see lib/presend.mjs) immediately before signing
 *   - verifies the RPC's chainId equals the chain the order settles on
 *   - claims the send in local state BEFORE broadcasting, so an ambiguous RPC
 *     result can never turn into a second transfer
 *   - on an ambiguous result, inspects chain state instead of rebroadcasting
 *
 * Exit codes: 0 confirmed, 1 refused/failed, 2 usage, 3 submitted but not
 * confirmed within the wait window (money may be in flight — never resend).
 */

import {
  parseArgs,
  emit,
  fail,
  usage,
  EXIT_ERROR,
  EXIT_UNCONFIRMED,
  SkillError,
  redact,
} from './lib/output.mjs';
import { assertRozoPaymentId, maskAddress } from './lib/ids.mjs';
import { chainName, decimalsFor } from './lib/amounts.mjs';
import { readKey, assertNoTrackedDotEnv, EVM_KEY_ENV } from './lib/keys.mjs';
import { preflight } from './lib/presend.mjs';
import { claimSend, recordSendResult } from './lib/state.mjs';

import { createPublicClient, createWalletClient, http, encodeFunctionData, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
];

const DEFAULT_RPC = {
  1: 'https://eth.llamarpc.com',
  56: 'https://bsc-dataseed.binance.org',
  137: 'https://polygon-rpc.com',
  8453: 'https://mainnet.base.org',
};

function rpcFor(chainId, override) {
  if (override && override !== true) return String(override);
  const env = process.env[`ROZO_CHECKOUT_RPC_${chainId}`];
  if (env) return env;
  const fallback = DEFAULT_RPC[String(chainId)];
  if (!fallback) {
    throw new SkillError(
      'NO_RPC',
      `No RPC known for chain ${chainId}. Pass --rpc <url> or set ROZO_CHECKOUT_RPC_${chainId}.`,
    );
  }
  return fallback;
}

function chainDef(chainId, rpcUrl) {
  return defineChain({
    id: Number(chainId),
    name: chainName(chainId),
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rozoPaymentId = assertRozoPaymentId(args['rozo-payment-id'] || args._[0]);

  assertNoTrackedDotEnv();
  const key = readKey(EVM_KEY_ENV);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new SkillError(
      'BAD_KEY_FORMAT',
      `${EVM_KEY_ENV} must be a 0x-prefixed 32-byte hex private key.`,
    );
  }
  const account = privateKeyToAccount(key);
  const sender = account.address;

  const { source, state, expiry, caps, amountAtomic } = await preflight({
    rozoPaymentId,
    expectFamily: 'evm',
    senderAddress: sender,
    allowLarge: Boolean(args['yes-large']),
  });

  const chainId = Number(source.chainId);
  const tokenAddress = source.tokenAddress;
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new SkillError('NO_TOKEN_ADDRESS', 'The order did not carry a usable ERC-20 address.');
  }
  const to = source.receiverAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new SkillError('BAD_DEPOSIT_ADDRESS', 'The deposit address is not a valid EVM address.');
  }

  const rpcUrl = rpcFor(chainId, args.rpc);
  const chain = chainDef(chainId, rpcUrl);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  // The RPC must be on the chain the order settles on. A misconfigured RPC is
  // the classic way to send real money onto the wrong network.
  let rpcChainId;
  try {
    rpcChainId = await pub.getChainId();
  } catch (err) {
    throw new SkillError('RPC_UNREACHABLE', `RPC did not respond: ${redact(err?.message)}`);
  }
  if (Number(rpcChainId) !== chainId) {
    throw new SkillError(
      'RPC_CHAIN_MISMATCH',
      `RPC reports chain ${rpcChainId} but this order settles on ${chainId}. Refusing to sign.`,
    );
  }

  // On-chain decimals must agree with our table (BNB Chain is 18, not 6).
  let onChainDecimals;
  try {
    onChainDecimals = Number(
      await pub.readContract({ address: tokenAddress, abi: ERC20_TRANSFER_ABI, functionName: 'decimals' }),
    );
  } catch (err) {
    throw new SkillError('TOKEN_READ_FAILED', `Could not read token decimals: ${redact(err?.message)}`);
  }
  const expectedDecimals = decimalsFor(source.chainId, source.tokenSymbol);
  if (onChainDecimals !== expectedDecimals) {
    throw new SkillError(
      'DECIMALS_MISMATCH',
      `Token reports ${onChainDecimals} decimals but ${source.tokenSymbol} on ${chainName(chainId)} ` +
        `is expected to have ${expectedDecimals}. Refusing to sign an amount that could be off by ` +
        'orders of magnitude.',
    );
  }

  let balance;
  try {
    balance = await pub.readContract({
      address: tokenAddress,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'balanceOf',
      args: [sender],
    });
  } catch (err) {
    throw new SkillError('TOKEN_READ_FAILED', `Could not read balance: ${redact(err?.message)}`);
  }
  if (balance < amountAtomic) {
    throw new SkillError(
      'INSUFFICIENT_BALANCE',
      `Sender holds ${balance} atomic units of ${source.tokenSymbol} on ${chainName(chainId)}; ` +
        `${amountAtomic} are required.`,
    );
  }

  if (args['dry-run']) {
    emit({
      success: true,
      step: 'send-evm-dry-run',
      rozoPaymentId,
      linkId: state.linkId,
      wouldSend: {
        chainId,
        chain: chainName(chainId),
        tokenSymbol: source.tokenSymbol,
        amountAtomic: amountAtomic.toString(),
        amount: source.amount,
        toMasked: maskAddress(to),
        fromMasked: maskAddress(sender),
      },
      caps,
      minutesOfSlack: Math.floor(expiry.msOfSlack / 60000),
      note: 'Nothing was signed or broadcast.',
    });
  }

  // Claim BEFORE broadcasting.
  claimSend(rozoPaymentId, {
    chainId: String(chainId),
    tokenSymbol: source.tokenSymbol,
    from: sender,
    to,
    amountAtomic: amountAtomic.toString(),
    memo: null,
  });

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, amountAtomic],
  });

  let txHash = null;
  try {
    txHash = await wallet.sendTransaction({ to: tokenAddress, data, value: 0n });
  } catch (err) {
    // Ambiguous: the node may have accepted the transaction before erroring.
    // Never blind-rebroadcast — inspect the nonce instead.
    let nonceMoved = null;
    try {
      const pending = await pub.getTransactionCount({ address: sender, blockTag: 'pending' });
      const latest = await pub.getTransactionCount({ address: sender, blockTag: 'latest' });
      nonceMoved = pending > latest;
    } catch {
      nonceMoved = null;
    }
    recordSendResult(rozoPaymentId, {
      status: nonceMoved ? 'ambiguous' : 'failed',
      note: redact(err?.shortMessage || err?.message || 'broadcast failed'),
    });
    emit(
      {
        success: false,
        step: 'send-evm',
        rozoPaymentId,
        error: {
          code: nonceMoved ? 'BROADCAST_AMBIGUOUS' : 'BROADCAST_FAILED',
          message: redact(err?.shortMessage || err?.message || 'broadcast failed'),
        },
        pendingNonceAhead: nonceMoved,
        guidance: nonceMoved
          ? 'A transaction may already be in flight from this wallet. Do NOT resend. Check the ' +
            'sender address on a block explorer and poll status.js.'
          : 'Nothing appears to have been broadcast, but this order is now locked against a ' +
            'second automated send. Verify on chain before doing anything else.',
      },
      EXIT_ERROR,
    );
  }

  recordSendResult(rozoPaymentId, { status: 'submitted', txHash });

  let receipt = null;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  } catch {
    receipt = null;
  }

  if (!receipt) {
    emit(
      {
        success: true,
        step: 'send-evm',
        submitted: true,
        confirmed: false,
        rozoPaymentId,
        linkId: state.linkId,
        txHash,
        guidance:
          'Broadcast but not confirmed within the wait window. Do NOT resend. Poll status.js; ' +
          'receipt truth is the backend confirmedAt/amountReceived, not this response.',
      },
      EXIT_UNCONFIRMED,
    );
  }

  recordSendResult(rozoPaymentId, {
    status: receipt.status === 'success' ? 'confirmed' : 'failed',
    txHash,
    note: `receipt status ${receipt.status}`,
  });

  emit({
    success: receipt.status === 'success',
    step: 'send-evm',
    submitted: true,
    confirmed: receipt.status === 'success',
    rozoPaymentId,
    linkId: state.linkId,
    txHash,
    blockNumber: receipt.blockNumber?.toString?.() ?? null,
    sent: {
      chain: chainName(chainId),
      tokenSymbol: source.tokenSymbol,
      amount: source.amount,
      toMasked: maskAddress(to),
      fromMasked: maskAddress(sender),
    },
    nextStep: `status.js --rozo-payment-id ${rozoPaymentId} --watch`,
    guidance:
      'On-chain confirmation is not settlement. Poll status.js until the state is `settled`.',
  });
}

main().catch((err) => fail(err));
