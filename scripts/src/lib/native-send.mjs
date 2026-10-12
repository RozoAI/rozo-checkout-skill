/**
 * Transaction construction for native coin payments (Mode B, --send).
 *
 * A native order is paid with a plain value transfer: on EVM a transaction
 * whose `value` is the exact wei amount and whose `data` is empty; on Solana a
 * System Program transfer of the exact lamports. No token contract, no mint.
 *
 * Everything that guards an ERC-20 / SPL send still applies: the send scripts
 * run the same preflight (confirmation digest, reuse guard, blacklist on
 * sender and destination, expiry including the price lock), the same final
 * payability check, claim-before-broadcast and the no-rebroadcast rule. This
 * module only covers what is different for a native coin, and is pure enough
 * to test against stubbed RPC clients:
 *
 *   NATIVE_TOKEN_ADDRESS_UNEXPECTED  the order names a contract or mint where a
 *                                    native coin was expected
 *   BAD_DEPOSIT_ADDRESS              the deposit address does not parse
 *   INSUFFICIENT_BALANCE             the wallet holds less than the amount
 *   INSUFFICIENT_GAS                 it holds the amount but not amount + fee
 *   DEPOSIT_ACCOUNT_NOT_WALLET       (Solana) the deposit address is a token
 *                                    account or program, not a wallet
 *   DEPOSIT_BELOW_RENT               (Solana) a new deposit account would be
 *                                    left below the rent-exempt minimum
 */

import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

import { SkillError, redact } from './output.mjs';
import { isNativeTokenAddress } from './amounts.mjs';
import { evmGasPrecheck, solFeePrecheck, formatAtomic } from './gas.mjs';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function assertNativeTokenAddress(tokenAddress) {
  if (!isNativeTokenAddress(tokenAddress)) {
    throw new SkillError(
      'NATIVE_TOKEN_ADDRESS_UNEXPECTED',
      'This native coin order names a token contract or mint, which a native payment never ' +
        'uses. Refusing to guess which asset to send.',
    );
  }
}

function assertPositive(amountAtomic) {
  if (typeof amountAtomic !== 'bigint' || amountAtomic <= 0n) {
    throw new SkillError('DEPOSIT_INCOMPLETE', 'The order carries no positive native amount.');
  }
}

/**
 * EVM: check balance and fee for a native value transfer and return the exact
 * request to sign: { to, value } and nothing else.
 *
 * `client` is a viem public client (getBalance, estimateGas,
 * estimateFeesPerGas). `estimateL1Fee` is required on OP-stack chains (Base),
 * exactly as for an ERC-20 send.
 */
export async function prepareEvmNativeSend({
  client,
  chainId,
  from,
  to,
  amountAtomic,
  tokenAddress,
  tokenSymbol,
  estimateL1Fee = null,
}) {
  assertNativeTokenAddress(tokenAddress);
  assertPositive(amountAtomic);
  if (!EVM_ADDRESS_RE.test(String(to ?? ''))) {
    throw new SkillError('BAD_DEPOSIT_ADDRESS', 'The deposit address is not a valid EVM address.');
  }

  let balance;
  try {
    balance = await client.getBalance({ address: from });
  } catch (err) {
    throw new SkillError(
      'GAS_CHECK_UNAVAILABLE',
      `Could not read the ${tokenSymbol} balance: ${redact(err?.shortMessage || err?.message || 'unknown error')}. ` +
        'This is not evidence of a shortfall. Nothing was signed.',
    );
  }
  if (balance < amountAtomic) {
    throw new SkillError(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${formatAtomic(balance, 18)} ${tokenSymbol}; the order needs exactly ` +
        `${formatAtomic(amountAtomic, 18)} ${tokenSymbol} plus the network fee. Nothing was signed.`,
    );
  }

  // Same precheck as an ERC-20 send, on the exact transfer about to be signed,
  // with the payment itself counted against the fee coin balance.
  const networkFee = await evmGasPrecheck({
    client,
    chainId,
    from,
    to,
    data: undefined,
    value: amountAtomic,
    estimateL1Fee,
  });

  return { request: { to, value: amountAtomic }, balance, networkFee };
}

/**
 * After viem fills in nonce / gas / fees, the request must still be exactly a
 * value transfer of the confirmed amount to the confirmed address, with no
 * calldata. Anything else is refused before signing.
 */
export function assertPreparedNativeRequest(prepared, { to, value }) {
  const gotTo = String(prepared?.to ?? '').toLowerCase();
  const data = prepared?.data;
  if (gotTo !== String(to).toLowerCase()) {
    throw new SkillError('PREPARED_TX_MISMATCH', 'The prepared transaction is not addressed to the deposit address.');
  }
  if (prepared?.value !== value) {
    throw new SkillError('PREPARED_TX_MISMATCH', 'The prepared transaction does not carry the exact order amount.');
  }
  if (data !== undefined && data !== null && data !== '0x' && data !== '') {
    throw new SkillError('PREPARED_TX_MISMATCH', 'A native payment must not carry calldata.');
  }
  return true;
}

/**
 * Solana: build the System Program transfer (plus the memo, if the order has
 * one), check the deposit account and the payer's SOL, and return the
 * unsigned transaction with its blockhash.
 *
 * `connection` is a web3.js Connection (getAccountInfo, getBalance,
 * getMinimumBalanceForRentExemption, getLatestBlockhash, getFeeForMessage).
 */
export async function prepareSolNativeSend({
  connection,
  payer,
  recipientAddress,
  amountAtomic,
  memo = null,
  tokenAddress,
}) {
  assertNativeTokenAddress(tokenAddress);
  assertPositive(amountAtomic);

  let recipient;
  try {
    recipient = new PublicKey(recipientAddress);
  } catch {
    throw new SkillError('BAD_DEPOSIT_ADDRESS', 'The deposit address is not a valid Solana address.');
  }

  let info;
  let rentMin;
  let balance;
  try {
    info = await connection.getAccountInfo(recipient, 'confirmed');
    rentMin = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    balance = BigInt(await connection.getBalance(payer, 'confirmed'));
  } catch (err) {
    throw new SkillError(
      'RPC_READ_FAILED',
      `Could not read the Solana accounts: ${redact(err?.message || 'unknown error')}. Nothing was signed.`,
    );
  }

  // Lamports sent to a token account or a program are not a deposit the
  // backend credits: only a plain wallet (System Program owned) is accepted.
  if (info && (info.executable || !info.owner?.equals?.(SystemProgram.programId))) {
    throw new SkillError(
      'DEPOSIT_ACCOUNT_NOT_WALLET',
      'The deposit address is not a plain Solana wallet (it is a token account or a program). ' +
        'Refusing to send SOL to it.',
    );
  }
  // A brand-new account must end at or above the rent-exempt minimum, or the
  // transfer fails on chain after the order is already locked against a resend.
  if (!info && amountAtomic < rentMin) {
    throw new SkillError(
      'DEPOSIT_BELOW_RENT',
      `The deposit address does not exist yet and ${formatAtomic(amountAtomic, 9)} SOL is below ` +
        `the ${formatAtomic(rentMin, 9)} SOL needed to open it. Pay this order another way.`,
    );
  }

  if (balance < amountAtomic) {
    throw new SkillError(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${formatAtomic(balance, 9)} SOL; the order needs exactly ` +
        `${formatAtomic(amountAtomic, 9)} SOL plus the network fee. Nothing was signed.`,
    );
  }

  const tx = new Transaction();
  tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: amountAtomic }));
  if (memo) {
    tx.add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(String(memo), 'utf8'),
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;

  const networkFee = await solFeePrecheck({
    connection,
    payer,
    message: tx.compileMessage(),
    value: amountAtomic,
  });

  return { tx, recipient, blockhash, lastValidBlockHeight, networkFee, recipientExists: Boolean(info) };
}
