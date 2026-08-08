/**
 * Shared Mode B pre-flight (PLAN §3 step 6b + §5).
 *
 * Everything here runs again, live, immediately before a signature — nothing
 * is trusted from the create-order run except the local send-once record.
 *
 * Order of checks (all hard aborts):
 *   NO_ORDER_STATE     -> create-order.js was never run for this id
 *   ALREADY_SENT       -> a send is already recorded (claimed later, see claimSend)
 *   ORDER_ALREADY_FUNDED / REUSED_SOURCE_MISMATCH -> live reuse guard
 *   DEPOSIT_CHANGED    -> live deposit address/amount differs from the record
 *   EXPIRY_MARGIN      -> not enough time left on this chain
 *   LINK_NO_LONGER_PAYABLE -> Coinbase resource consumed meanwhile
 *   BLACKLIST_UNAVAILABLE / BLACKLIST_HIT -> compromised-address rails
 *   CAP_PER_TX / CAP_SESSION -> hot-wallet spend caps
 */

import { getPayment, invoiceStatus } from './api.mjs';
import { reuseGuard, checkPayable } from './guards.mjs';
import { checkExpiry } from './expiry.mjs';
import { assertNotBlacklisted, loadBlacklist } from './blacklist.mjs';
import { readState, assertSpendCaps } from './state.mjs';
import { chainFamily, sourceAtomic } from './amounts.mjs';
import { SkillError } from './output.mjs';

/**
 * @param {object} args
 * @param {string} args.rozoPaymentId
 * @param {string} args.expectFamily   "evm" | "solana"
 * @param {string} args.senderAddress  derived from the env key, never printed as a key
 * @param {boolean} [args.allowLarge]
 * @returns {Promise<{payment, source, state, expiry, caps, blacklist}>}
 */
export async function preflight({ rozoPaymentId, expectFamily, senderAddress, allowLarge = false }) {
  // 0. Blacklist must load before anything else; fail closed.
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

  // 4. The deposit instructions must be byte-identical to what was confirmed.
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

  // 8. Spend caps.
  const caps = assertSpendCaps(state.invoiceAmount, { allowLarge });

  const amountAtomic = sourceAtomic(source, 'amount');
  if (amountAtomic === null || amountAtomic <= 0n) {
    throw new SkillError('BAD_DEPOSIT_AMOUNT', 'The order has no positive deposit amount.');
  }

  return { payment, source, state, expiry, caps, blacklist, amountAtomic, statusNow };
}
