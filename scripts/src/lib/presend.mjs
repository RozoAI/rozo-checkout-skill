/**
 * Shared Mode B pre-flight (PLAN §3 step 6b + §5).
 *
 * Everything here runs again, live, immediately before a signature — nothing
 * is trusted from the create-order run except the local send-once record.
 *
 * Order of checks (all hard aborts):
 *   SEND_NOT_OPTED_IN  -> --send was not passed
 *   NO_ORDER_STATE     -> create-order.js was never run for this id
 *   NOT_CONFIRMED      -> no confirmation record from `create-order --confirm`
 *   ALREADY_SENT       -> a send is already recorded (claimed later, see claimSend)
 *   ORDER_ALREADY_FUNDED / REUSED_SOURCE_MISMATCH -> live reuse guard
 *   DEPOSIT_INCOMPLETE / DEPOSIT_MEMO_REQUIRED -> unusable instructions
 *   CONFIRMATION_STALE -> live deposit data differs from what was confirmed
 *   DEPOSIT_CHANGED    -> live deposit address/amount differs from the record
 *   EXPIRY_MARGIN      -> not enough time left on this chain
 *   LINK_NO_LONGER_PAYABLE / LINK_PAYABILITY_UNKNOWN -> Coinbase state
 *   BLACKLIST_UNAVAILABLE / BLACKLIST_HIT -> compromised-address rails
 *   CAP_PER_TX -> the single per-payment limit (charged at claim time)
 *
 * `finalPayabilityCheck` is exported separately and MUST be called again as the
 * very last step before signing, after all the slow RPC preparation.
 */

import { getPayment, invoiceStatus } from './api.mjs';
import { reuseGuard, checkPayable, validateDepositInstructions } from './guards.mjs';
import { checkExpiry } from './expiry.mjs';
import { assertNotBlacklisted, loadBlacklist } from './blacklist.mjs';
import { readState, depositDigest } from './state.mjs';
import { chainFamily } from './amounts.mjs';
import { SkillError } from './output.mjs';

/**
 * @param {object} args
 * @param {string} args.rozoPaymentId
 * @param {string} args.expectFamily   "evm" | "solana"
 * @param {string} args.senderAddress  derived from the env key, never printed as a key
 * @returns {Promise<{payment, source, state, expiry, caps, blacklist}>}
 */
export async function preflight({
  rozoPaymentId,
  expectFamily,
  senderAddress,
  send = false,
  dryRun = false,
}) {
  // 0a. Moving money requires an explicit opt-in on the command line. Being
  //     able to run the documented command must not be enough.
  if (!send && !dryRun) {
    throw new SkillError(
      'SEND_NOT_OPTED_IN',
      'Refusing to move funds without the explicit --send flag. Add --dry-run to see exactly ' +
        'what would be signed instead.',
    );
  }

  // 0b. Blacklist must load before anything else; fail closed.
  let blacklist;
  try {
    blacklist = loadBlacklist();
  } catch (err) {
    throw new SkillError(
      'BLACKLIST_UNAVAILABLE',
      `Compromised-address list unusable: ${err.message} Refusing to send.`,
    );
  }

  // 1. Local record must exist (and must not already carry a send).
  const state = readState(rozoPaymentId);
  if (!state) {
    throw new SkillError(
      'NO_ORDER_STATE',
      'No local record for this order. Run create-order.js first, in the same environment.',
    );
  }
  if (state.send) {
    throw new SkillError(
      'ALREADY_SENT',
      `A send was already recorded for this order at ${state.send.claimedAt} ` +
        `(status: ${state.send.status}). Refusing to send twice.`,
      { send: state.send },
    );
  }

  // 1b. A human must have been shown the full deposit instructions and said
  //     yes, via `create-order.js --confirm`, in this state directory.
  if (!state.confirmation) {
    throw new SkillError(
      'NOT_CONFIRMED',
      'This order has never been confirmed. Run `create-order.js --url <link> --chain <id> ' +
        '--token <SYM> --confirm` first, show the user the deposit block it prints, and get an ' +
        'explicit yes before sending.',
    );
  }

  // 2. Live, authoritative payment detail. The address we sign against comes
  //    from THIS call — never from argv, cache, or a previous session.
  const payment = await getPayment(rozoPaymentId);
  const source = payment?.source || {};

  const family = chainFamily(source.chainId);
  if (family !== expectFamily) {
    throw new SkillError(
      'WRONG_SENDER_SCRIPT',
      `This order settles on a ${family ?? 'unknown'} chain; use the matching send script.`,
    );
  }

  // 3. Reuse / money-detected guard, re-run live.
  const guard = reuseGuard({
    payment,
    requested: { chainId: state.source.chainId, tokenSymbol: state.source.tokenSymbol },
  });
  if (!guard.ok) {
    throw new SkillError(guard.code, guard.reason, {
      ...guard.evidence,
      moneyDetected: guard.moneyDetected,
    });
  }

  // 3b. The instructions must be complete and payable as they stand.
  const deposit = validateDepositInstructions(source);
  if (!deposit.ok) throw new SkillError(deposit.code, deposit.reason);

  // 4a. The live deposit data must be exactly what the human confirmed.
  const liveDigest = depositDigest(source);
  if (liveDigest !== state.confirmation.depositDigest) {
    throw new SkillError(
      'CONFIRMATION_STALE',
      'The live deposit instructions differ from the ones that were confirmed. Re-run ' +
        'create-order.js --confirm, show the user the new details, and get a fresh yes.',
    );
  }

  // 4b. The deposit instructions must also match the record written at create.
  if (source.receiverAddress !== state.receiverAddress) {
    throw new SkillError(
      'DEPOSIT_CHANGED',
      'The live deposit address differs from the one recorded at create time. Refusing to send.',
    );
  }
  if (String(source.amount) !== String(state.amount)) {
    throw new SkillError(
      'DEPOSIT_CHANGED',
      `The live deposit amount (${source.amount}) differs from the recorded one (${state.amount}).`,
    );
  }
  if ((source.receiverMemo ?? null) !== (state.receiverMemo ?? null)) {
    throw new SkillError('DEPOSIT_CHANGED', 'The live deposit memo differs from the recorded one.');
  }

  // 5. Expiry margins.
  const statusNow = await invoiceStatus({ linkId: state.linkId });
  const expiry = checkExpiry({
    now: Date.now(),
    chainId: source.chainId,
    intentExpiresAt: payment?.expiresAt,
    coinbaseExpiry: statusNow?.coinbase?.preApprovalExpiry,
  });
  if (!expiry.ok) throw new SkillError(expiry.code, expiry.reason, expiry);

  // 6. Payability revalidation immediately before signing.
  const payable = checkPayable(statusNow, Date.now());
  if (!payable.ok) throw new SkillError(payable.code, payable.reason, payable.derived);

  // 7. Blacklist: destination AND sender.
  assertNotBlacklisted(
    [
      { address: source.receiverAddress, family, role: 'deposit address' },
      { address: senderAddress, family, role: 'sender wallet' },
    ],
    blacklist,
  );

  // 8. The payment limit is charged atomically at claim time (see claimSend),
  //    not here, so two concurrent runs cannot both pass a preview check.

  return {
    payment,
    source,
    state,
    expiry,
    blacklist,
    amountAtomic: deposit.amountAtomic,
    deposit,
    statusNow,
  };
}

/**
 * Re-prove payability and the expiry margin as the LAST step before signing.
 *
 * `preflight` runs before the RPC round-trips (chain id, decimals, balance,
 * blockhash), which can take many seconds; the Coinbase link can be consumed
 * by another payer in that window. Both send scripts call this immediately
 * before they broadcast.
 */
export async function finalPayabilityCheck({ linkId, chainId, intentExpiresAt }) {
  const statusNow = await invoiceStatus({ linkId });
  const payable = checkPayable(statusNow, Date.now());
  if (!payable.ok) throw new SkillError(payable.code, payable.reason, payable.derived);

  const expiry = checkExpiry({
    now: Date.now(),
    chainId,
    intentExpiresAt,
    coinbaseExpiry: statusNow?.coinbase?.preApprovalExpiry,
  });
  if (!expiry.ok) throw new SkillError(expiry.code, expiry.reason, expiry);

  return { statusNow, payable, expiry };
}
