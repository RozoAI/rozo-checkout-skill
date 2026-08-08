#!/usr/bin/env node
/**
 * send-sol.js — Mode B, Solana only (USDC / USDT SPL transfers).
 *
 *   ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
 *     node scripts/dist/send-sol.js --rozo-payment-id <uuid> --send
 *
 * Same rails as send-evm.js: refuses to run without `--send` and without a
 * confirmation recorded by `create-order.js --confirm` that still matches the
 * live deposit data; env-only key; live re-checks before signing; a
 * genesis-hash check that the RPC really is mainnet; payability re-proved as
 * the last step before broadcast; claim-before-broadcast; and no blind
 * rebroadcast on an ambiguous result.
 *
 * A Solana order may carry `source.receiverMemo`. When it does, the memo
 * instruction is included in the same transaction — a deposit that needs a
 * memo and arrives without one is how funds get lost.
 */

import {
  parseArgs,
  emit,
  fail,
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
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = assertRozoPaymentId(args['rozo-payment-id'] || args._[0]);

  assertNoTrackedDotEnv();
  // A .env in the working directory supplies the hot-wallet settings when they
  // are not already in the real environment. Allow-listed keys only, parsed as
  // plain text — never evaluated by a shell.
  const dotenv = applyDotenv({ file: args['env-file'] });
  // Most Solana users already have ~/.config/solana/id.json from solana-keygen;
  // that is preferred over a raw key in the environment.
  const plan = planKeySource({ family: 'solana', keyfile: args.keyfile });
  const loaded = await loadKeySource(plan, { family: 'solana', askPassphrase: promptPassphrase });
  const secret = loaded.secretKey;
  const keypair =
    secret.length === 64 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret);
  const sender = keypair.publicKey.toBase58();
  const keySource = loaded.label;

  const dryRun = Boolean(args['dry-run']);
  const { source, state, expiry, amountAtomic, payment } = await preflight({
    rozoPaymentId,
    expectFamily: 'solana',
    senderAddress: sender,
    send: Boolean(args.send),
    dryRun,
  });

  const rpcUrl =
    (args.rpc && args.rpc !== true && String(args.rpc)) ||
    process.env.ROZO_CHECKOUT_RPC_900 ||
    'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  // Prove the RPC is Solana mainnet before signing anything.
  let genesis;
  try {
    genesis = await connection.getGenesisHash();
  } catch (err) {
    throw new SkillError('RPC_UNREACHABLE', `RPC did not respond: ${redact(err?.message)}`);
  }
  if (genesis !== MAINNET_GENESIS) {
    throw new SkillError(
      'RPC_CHAIN_MISMATCH',
      'The configured Solana RPC is not mainnet-beta. Refusing to sign.',
    );
  }

  let mint;
  try {
    mint = new PublicKey(source.tokenAddress);
  } catch {
    throw new SkillError('NO_TOKEN_ADDRESS', 'The order did not carry a usable SPL mint address.');
  }
  let recipient;
  try {
    recipient = new PublicKey(source.receiverAddress);
  } catch {
    throw new SkillError('BAD_DEPOSIT_ADDRESS', 'The deposit address is not a valid Solana address.');
  }

  const mintInfo = await getMint(connection, mint);
  const expectedDecimals = decimalsFor(source.chainId, source.tokenSymbol);
  if (mintInfo.decimals !== expectedDecimals) {
    throw new SkillError(
      'DECIMALS_MISMATCH',
      `Mint reports ${mintInfo.decimals} decimals, expected ${expectedDecimals} for ` +
        `${source.tokenSymbol} on Solana. Refusing to sign.`,
    );
  }

  const fromAta = await getAssociatedTokenAddress(mint, keypair.publicKey);
  let fromAccount;
  try {
    fromAccount = await getAccount(connection, fromAta);
  } catch {
    throw new SkillError(
      'NO_TOKEN_ACCOUNT',
      `The sender has no ${source.tokenSymbol} token account on Solana.`,
    );
  }
  if (fromAccount.amount < amountAtomic) {
    throw new SkillError(
      'INSUFFICIENT_BALANCE',
      `Sender holds ${fromAccount.amount} atomic units; ${amountAtomic} are required.`,
    );
  }

  // The backend hands out the recipient's TOKEN account for SPL deposits when
  // it can; if it handed a wallet address, derive its ATA. Either way we
  // transfer to a token account owned by that address.
  let toAta;
  let toIsTokenAccount = false;
  try {
    const acc = await getAccount(connection, recipient);
    if (acc.mint.toBase58() !== mint.toBase58()) {
      throw new SkillError(
        'DEPOSIT_ACCOUNT_MISMATCH',
        'The deposit token account is for a different mint. Refusing to send.',
      );
    }
    toAta = recipient;
    toIsTokenAccount = true;
  } catch (err) {
    if (err instanceof SkillError) throw err;
    toAta = await getAssociatedTokenAddress(mint, recipient);
    try {
      await getAccount(connection, toAta);
    } catch {
      throw new SkillError(
        'DEPOSIT_ACCOUNT_MISSING',
        'The deposit address has no token account for this mint. Refusing to create one on its ' +
          'behalf — re-run create-order.js for fresh instructions.',
      );
    }
  }

  if (dryRun) {
    emit({
      success: true,
      step: 'send-sol-dry-run',
      rozoPaymentId,
      linkId: state.linkId,
      wouldSend: {
        chain: chainName(900),
        tokenSymbol: source.tokenSymbol,
        amountAtomic: amountAtomic.toString(),
        amount: source.amount,
        toMasked: maskAddress(source.receiverAddress),
        fromMasked: maskAddress(sender),
        toIsTokenAccount,
        withMemo: Boolean(source.receiverMemo),
      },
      confirmedAt: state.confirmation?.confirmedAt ?? null,
      keySource,
      // Key NAMES only — a value from a .env is never echoed.
      envFile: dotenv ? { path: dotenv.path, applied: dotenv.applied } : null,
      minutesOfSlack: Math.floor(expiry.msOfSlack / 60000),
      note: 'Nothing was signed or broadcast. Add --send (without --dry-run) to execute.',
    });
  }

  const tx = new Transaction();
  tx.add(
    createTransferCheckedInstruction(
      fromAta,
      mint,
      toAta,
      keypair.publicKey,
      amountAtomic,
      mintInfo.decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  if (source.receiverMemo) {
    tx.add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(String(source.receiverMemo), 'utf8'),
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const signature = tx.signatures[0]?.signature
    ? base58Encode(tx.signatures[0].signature)
    : null;

  // Last gate before money moves: the Coinbase link may have been consumed
  // while the RPC preparation above was running.
  await finalPayabilityCheck({
    linkId: state.linkId,
    chainId: source.chainId,
    intentExpiresAt: payment?.expiresAt,
  });

  // Claim (and charge the spend caps) atomically, BEFORE broadcasting. The
  // signature is already known, so an ambiguous send can be resolved exactly.
  claimSend(
    rozoPaymentId,
    {
      chainId: '900',
      tokenSymbol: source.tokenSymbol,
      from: sender,
      to: source.receiverAddress,
      amountAtomic: amountAtomic.toString(),
      memo: source.receiverMemo ?? null,
      expectedTxHash: signature,
    },
  );

  let sent = null;
  try {
    sent = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (err) {
    // A signed transaction with a known signature may still land. Check the
    // signature status rather than re-signing with a new blockhash.
    let landed = null;
    if (signature) {
      try {
        const st = await connection.getSignatureStatus(signature);
        landed = Boolean(st?.value);
      } catch {
        landed = null;
      }
    }
    recordSendResult(rozoPaymentId, {
      status: landed ? 'ambiguous' : 'failed',
      txHash: signature,
      note: redact(err?.message || 'broadcast failed'),
    });
    emit(
      {
        success: false,
        step: 'send-sol',
        rozoPaymentId,
        error: {
          code: landed ? 'BROADCAST_AMBIGUOUS' : 'BROADCAST_FAILED',
          message: redact(err?.message || 'broadcast failed'),
        },
        signature,
        guidance: landed
          ? 'The signed transaction may already be on chain. Do NOT resend. Check the signature ' +
            'on an explorer and poll status.js.'
          : 'Nothing appears to have landed, but this order is now locked against a second ' +
            'automated send. Verify on chain before doing anything else.',
      },
      EXIT_ERROR,
    );
  }

  recordSendResult(rozoPaymentId, { status: 'submitted', txHash: sent });

  // Three distinct outcomes, which must not be conflated:
  //   executionError — the transaction landed and FAILED (value.err)
  //   confirmed      — the transaction landed and succeeded
  //   unresolved     — we simply never heard back within the window
  let confirmed = false;
  let executionError = null;
  try {
    const res = await connection.confirmTransaction(
      { signature: sent, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (res?.value?.err) {
      executionError = res.value.err;
    } else {
      confirmed = true;
    }
  } catch {
    confirmed = false;
  }

  if (executionError) {
    const outcome = broadcastOutcome({ executionError });
    recordSendResult(rozoPaymentId, {
      status: outcome.recordStatus,
      txHash: sent,
      note: redact(JSON.stringify(executionError)),
    });
    emit(
      {
        success: false,
        step: 'send-sol',
        submitted: true,
        confirmed: false,
        rozoPaymentId,
        linkId: state.linkId,
        txHash: sent,
        error: {
          code: broadcastOutcome({ executionError }).code,
          message: `The transaction landed but failed on chain: ${redact(JSON.stringify(executionError))}`,
        },
        guidance:
          'The transfer failed, so no funds moved — but this order stays locked against a ' +
          'second automated send. Investigate before retrying anything.',
      },
      EXIT_ERROR,
    );
  }

  if (!confirmed) {
    emit(
      {
        success: true,
        step: 'send-sol',
        submitted: true,
        confirmed: false,
        rozoPaymentId,
        linkId: state.linkId,
        txHash: sent,
        guidance:
          'Broadcast but not confirmed within the wait window. Do NOT resend. Poll status.js; ' +
          'receipt truth is the backend confirmedAt/amountReceived.',
      },
      EXIT_UNCONFIRMED,
    );
  }

  recordSendResult(rozoPaymentId, { status: 'confirmed', txHash: sent });

  emit({
    success: true,
    step: 'send-sol',
    submitted: true,
    confirmed: true,
    rozoPaymentId,
    linkId: state.linkId,
    txHash: sent,
    sent: {
      chain: chainName(900),
      tokenSymbol: source.tokenSymbol,
      amount: source.amount,
      toMasked: maskAddress(source.receiverAddress),
      fromMasked: maskAddress(sender),
      withMemo: Boolean(source.receiverMemo),
      keySource,
    },
    nextStep: `status.js --rozo-payment-id ${rozoPaymentId} --watch`,
    guidance: 'On-chain confirmation is not settlement. Poll status.js until the state is `settled`.',
  });
}

/** base58-encode a signature buffer (no extra dependency). */
function base58Encode(buf) {
  let num = 0n;
  for (const b of buf) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of buf) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

/**
 * Entry point for both the standalone script and the CLI. The standalone
 * bundle (scripts/bin) calls this and lets emit() exit; the CLI calls it
 * inside capture() and gets the payload back. Same flow, same checks.
 */
export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
