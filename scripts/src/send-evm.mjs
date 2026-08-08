#!/usr/bin/env node
/**
 * send-evm.js — Mode B, EVM chains only (Ethereum, BNB Chain, Polygon, Base).
 *
 *   ROZO_CHECKOUT_EVM_KEY=0x... node scripts/dist/send-evm.js \
 *     --rozo-payment-id <uuid> --send
 *
 * This is the only EVM code path that moves money. It refuses to run without
 * `--send`, and refuses to run at all unless `create-order.js --confirm`
 * recorded a confirmation whose digest still matches the live deposit data. It:
 *   - reads the key from the environment only, never argv, never prints it
 *   - re-runs every live check (see lib/presend.mjs) before preparing the tx
 *   - re-proves payability as the LAST step before broadcast
 *   - verifies the RPC's chainId equals the chain the order settles on
 *   - signs first, so the tx hash is known before broadcast, and records that
 *     hash plus the pre-send nonce in local state BEFORE broadcasting
 *   - on an ambiguous result, looks the transaction up by hash instead of
 *     rebroadcasting
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
import { assertNoTrackedDotEnv } from './lib/keys.mjs';
import { planKeySource, loadKeySource } from './lib/key-source.mjs';
import { applyDotenv } from './lib/dotenv.mjs';
import { promptPassphrase } from './lib/passphrase.mjs';
import { preflight, finalPayabilityCheck } from './lib/presend.mjs';
import { claimSend, recordSendResult } from './lib/state.mjs';
import { broadcastOutcome } from './lib/outcomes.mjs';

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  defineChain,
  keccak256,
} from 'viem';
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

async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = assertRozoPaymentId(args['rozo-payment-id'] || args._[0]);

  assertNoTrackedDotEnv();
  // A .env in the working directory supplies the hot-wallet settings when they
  // are not already in the real environment. Allow-listed keys only, parsed as
  // plain text — never evaluated by a shell.
  const dotenv = applyDotenv({ file: args['env-file'] });
  // Where the key comes from is the only thing this resolves; every gate below
  // runs identically whichever source wins.
  const plan = planKeySource({ family: 'evm', keyfile: args.keyfile });
  const loaded = await loadKeySource(plan, { family: 'evm', askPassphrase: promptPassphrase });
  const account = privateKeyToAccount(loaded.privateKey);
  const sender = account.address;
  const keySource = loaded.label;

  const dryRun = Boolean(args['dry-run']);
  const { source, state, expiry, amountAtomic, payment } = await preflight({
    rozoPaymentId,
    expectFamily: 'evm',
    senderAddress: sender,
    send: Boolean(args.send),
    dryRun,
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

  if (dryRun) {
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
      confirmedAt: state.confirmation?.confirmedAt ?? null,
      keySource,
      // Key NAMES only — a value from a .env is never echoed.
      envFile: dotenv ? { path: dotenv.path, applied: dotenv.applied } : null,
      minutesOfSlack: Math.floor(expiry.msOfSlack / 60000),
      note: 'Nothing was signed or broadcast. Add --send (without --dry-run) to execute.',
    });
  }

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, amountAtomic],
  });

  // Sign first: this fixes the nonce and yields the transaction hash BEFORE
  // anything is broadcast, so an ambiguous send can be resolved by looking the
  // exact transaction up rather than by guessing from nonce arithmetic.
  const request = await wallet.prepareTransactionRequest({
    to: tokenAddress,
    data,
    value: 0n,
  });
  const serialized = await wallet.signTransaction(request);
  const expectedTxHash = keccak256(serialized);
  const nonceBefore = Number(request.nonce);

  // Last gate before money moves: the Coinbase link may have been consumed
  // while we were doing all of the above.
  await finalPayabilityCheck({
    linkId: state.linkId,
    chainId: source.chainId,
    intentExpiresAt: payment?.expiresAt,
  });

  // Claim (and charge the spend caps) atomically, BEFORE broadcasting.
  claimSend(
    rozoPaymentId,
    {
      chainId: String(chainId),
      tokenSymbol: source.tokenSymbol,
      from: sender,
      to,
      amountAtomic: amountAtomic.toString(),
      memo: null,
      nonceBefore,
      expectedTxHash,
    },
  );

  let txHash = null;
  try {
    txHash = await pub.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    // Ambiguous: the node may have accepted the transaction before erroring.
    // Never blind-rebroadcast — look up the exact hash we signed.
    let landed = null;
    try {
      const tx = await pub.getTransaction({ hash: expectedTxHash });
      landed = Boolean(tx);
    } catch {
      // Not found yet is not proof of absence; fall back to the nonce, which
      // is meaningful because we recorded it before signing.
      try {
        const latest = await pub.getTransactionCount({ address: sender, blockTag: 'latest' });
        landed = latest > nonceBefore ? true : null;
      } catch {
        landed = null;
      }
    }
    recordSendResult(rozoPaymentId, {
      status: landed ? 'ambiguous' : 'failed',
      txHash: expectedTxHash,
      note: redact(err?.shortMessage || err?.message || 'broadcast failed'),
    });
    emit(
      {
        success: false,
        step: 'send-evm',
        rozoPaymentId,
        error: {
          code: landed === false ? 'BROADCAST_FAILED' : 'BROADCAST_AMBIGUOUS',
          message: redact(err?.shortMessage || err?.message || 'broadcast failed'),
        },
        signedTxHash: expectedTxHash,
        nonceBefore,
        foundOnChain: landed,
        guidance:
          landed === false
            ? 'Nothing appears to have been broadcast, but this order is now locked against a ' +
              'second automated send. Verify the signed hash on a block explorer first.'
            : 'The signed transaction may already be in flight. Do NOT resend. Look up the ' +
              'signed hash above on a block explorer and poll status.js.',
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

  const outcome = broadcastOutcome({ receiptStatus: receipt.status });
  const succeeded = outcome.success;
  recordSendResult(rozoPaymentId, {
    status: outcome.recordStatus,
    txHash,
    note: `receipt status ${receipt.status}`,
  });

  emit(
    {
      success: succeeded,
      step: 'send-evm',
      submitted: true,
      confirmed: succeeded,
      rozoPaymentId,
      linkId: state.linkId,
      txHash,
      blockNumber: receipt.blockNumber?.toString?.() ?? null,
      ...(succeeded ? {} : { error: { code: outcome.code, message: 'The transfer reverted on chain.' } }),
      sent: {
        chain: chainName(chainId),
        tokenSymbol: source.tokenSymbol,
        amount: source.amount,
        toMasked: maskAddress(to),
        fromMasked: maskAddress(sender),
        keySource,
      },
      nextStep: `status.js --rozo-payment-id ${rozoPaymentId} --watch`,
      guidance: succeeded
        ? 'On-chain confirmation is not settlement. Poll status.js until the state is `settled`.'
        : 'The transfer reverted, so no funds moved — but this order stays locked against a ' +
          'second automated send. Investigate before retrying anything.',
    },
    // A reverted transfer is a failure, and the exit code has to say so.
    outcome.exitCode,
  );
}

/**
 * Entry point for both the standalone script and the CLI. The standalone
 * bundle (scripts/bin) calls this and lets emit() exit; the CLI calls it
 * inside capture() and gets the payload back. Same flow, same checks.
 */
export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
