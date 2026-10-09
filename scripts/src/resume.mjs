/**
 * resume — pick an existing order back up. READ-ONLY: creates nothing,
 * sends nothing, writes nothing.
 *
 *   rozo-checkout resume <rozoPaymentId>             (masked summary + payment page)
 *   rozo-checkout resume <rozoPaymentId> --confirm   (also the full deposit block)
 *
 * Built from the same pieces as status and create-order, so it cannot be
 * looser than either:
 *   1. status snapshot (both backend views, money-detected rule, local send
 *      record, send window = expiry margin + link payability)
 *   2. only `awaiting_deposit` with an open send window and no local send is
 *      resumable; paid, expired and unknown each get a clear answer instead
 *   3. a fresh GET payments/<id> re-checked with reuseGuard (unpaid, no tx,
 *      complete deposit instructions) and the compromised-address list
 *   4. the full address / memo / BOLT11 is withheld until --confirm, exactly
 *      like create-order
 *
 * Endpoints: GET {MPP}/invoice-status and GET {INTENTS}/payments/<id>.
 */

import { parseArgs, emit, usage, EXIT_OK, EXIT_ERROR, SkillError, publicPayPage } from './lib/output.mjs';
import { isRozoPaymentId, maskAddress, maskMemo } from './lib/ids.mjs';
import { getPayment } from './lib/api.mjs';
import { chainName, chainFamily, formatAmount, isSatsUnit, STELLAR_MEMO_TYPE } from './lib/amounts.mjs';
import { reuseGuard } from './lib/guards.mjs';
import { assertNotBlacklisted, loadBlacklist } from './lib/blacklist.mjs';
import { formatRemaining, checkExpiry } from './lib/expiry.mjs';
import { readState } from './lib/state.mjs';
import { SUPPORT } from './lib/support.mjs';
import { snapshot, statusGuidance, EXPIRED_UNFUNDED_GUIDANCE } from './status.mjs';

const PAID_STATES = new Set([
  'payin_detected',
  'payin_confirmed',
  'bridging',
  'paying_coinbase',
  'settled',
]);
const EXPIRED_STATES = new Set(['expired_unfunded', 'invoice_expired']);

function localPaymentLink(id) {
  try {
    return readState(id)?.paymentLink ?? null;
  } catch {
    return null;
  }
}

/**
 * Pure decision over a status snapshot: can this order be resumed, and if
 * not, what should the caller be told? Exported for tests.
 */
export function resumeVerdict(snap) {
  const base = {
    rozoPaymentId: snap.rozoPaymentId,
    linkId: snap.linkId ?? null,
    provider: snap.provider,
    state: snap.state,
    moneyDetected: Boolean(snap.moneyDetected),
  };
  if (snap.escalate) {
    return { ...base, resumable: false, outcome: 'needs_attention', code: 'ORDER_NEEDS_ATTENTION', exitCode: EXIT_ERROR, message: statusGuidance(snap) };
  }
  if (snap.unknown || !snap.authoritativeView) {
    return { ...base, resumable: false, outcome: 'unknown', code: 'ORDER_STATE_UNKNOWN', exitCode: EXIT_ERROR, message: statusGuidance(snap) };
  }
  if (snap.moneyDetected || PAID_STATES.has(snap.state)) {
    const done = snap.state === 'settled';
    return {
      ...base,
      resumable: false,
      outcome: done ? 'paid' : 'paid_in_progress',
      code: 'ORDER_ALREADY_PAID',
      exitCode: EXIT_OK,
      message: done
        ? 'This order is already paid and settled. Nothing to resume. Do not pay again.'
        : `A payment for this order was already detected (state: ${snap.state}). Do NOT pay ` +
          `again. Follow it with: rozo-checkout status ${snap.rozoPaymentId} --watch`,
    };
  }
  if (EXPIRED_STATES.has(snap.state)) {
    return {
      ...base,
      resumable: false,
      outcome: 'expired',
      code: 'ORDER_EXPIRED',
      exitCode: EXIT_ERROR,
      message:
        snap.provider === 'bitrefill'
          ? 'This order expired before any funds arrived. Nothing was lost. Create a fresh ' +
            'Bitrefill invoice and run pay again.'
          : EXPIRED_UNFUNDED_GUIDANCE,
    };
  }
  if (snap.localSend) {
    return {
      ...base,
      resumable: false,
      outcome: 'sent_locally',
      code: 'ALREADY_SENT',
      exitCode: EXIT_ERROR,
      message:
        `This machine already recorded a send for this order (${snap.localSend.status}). Do NOT ` +
        `pay again. Check it with: rozo-checkout status ${snap.rozoPaymentId}`,
    };
  }
  if (snap.state !== 'awaiting_deposit') {
    return {
      ...base,
      resumable: false,
      outcome: 'not_payable',
      code: 'ORDER_NOT_RESUMABLE',
      exitCode: EXIT_ERROR,
      message: `This order is in state "${snap.state}" and cannot be paid now. ${statusGuidance(snap)}`,
    };
  }
  if (!snap.sendWindow?.ok) {
    return {
      ...base,
      resumable: false,
      outcome: 'expired',
      code: snap.sendWindow?.code ?? 'SEND_WINDOW_CLOSED',
      exitCode: EXIT_ERROR,
      message:
        `${snap.sendWindow?.reason ?? 'Not enough time is left to pay this order safely.'} ` +
        'Do not fund it. Let it expire unfunded, then create a new order for the same link.',
    };
  }
  return { ...base, resumable: true, outcome: 'awaiting_deposit', code: null, exitCode: EXIT_OK, message: null };
}

async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = args['rozo-payment-id'] || args._[0];
  if (!rozoPaymentId || rozoPaymentId === true) usage('Required: <rozoPaymentId> (the order id printed by pay)');
  if (!isRozoPaymentId(String(rozoPaymentId))) {
    usage('resume takes the order id (rozoPaymentId, a UUID) printed by pay, not a payment link.');
  }
  const id = String(rozoPaymentId);
  const confirmed = Boolean(args.confirm);

  let blacklist;
  try {
    blacklist = loadBlacklist();
  } catch (err) {
    throw new SkillError('BLACKLIST_UNAVAILABLE', `Compromised-address list unusable: ${err.message} Refusing to proceed.`);
  }

  const snap = await snapshot({ rozoPaymentId: id });
  const verdict = resumeVerdict(snap);

  if (!verdict.resumable) {
    emit(
      {
        success: verdict.exitCode === EXIT_OK,
        step: 'resume',
        resumable: false,
        outcome: verdict.outcome,
        rozoPaymentId: id,
        linkId: verdict.linkId,
        state: verdict.state,
        moneyDetected: verdict.moneyDetected,
        ...(verdict.exitCode === EXIT_OK
          ? { message: verdict.message }
          : { error: { code: verdict.code, message: verdict.message } }),
        payin: snap.payin,
        ...(verdict.exitCode === EXIT_OK ? {} : { support: SUPPORT }),
      },
      verdict.exitCode,
    );
  }

  // Fresh authoritative read, re-checked as strictly as a reused order is at
  // create time. requested = the order's own source, so this checks state and
  // completeness, not the user's coin choice (which the order already fixes).
  const payment = await getPayment(id);
  const source = payment?.source || {};
  const guard = reuseGuard({ payment, requested: { chainId: source.chainId, tokenSymbol: source.tokenSymbol }, reused: true });
  if (!guard.ok) {
    emit(
      {
        success: false,
        step: 'resume',
        resumable: false,
        outcome: guard.moneyDetected ? 'paid_in_progress' : 'not_payable',
        rozoPaymentId: id,
        moneyDetected: guard.moneyDetected,
        error: { code: guard.code, message: guard.reason },
        guidance: guard.moneyDetected
          ? 'A payment for this order was detected. Do NOT pay again.'
          : 'This order cannot be paid as it stands. Do not fund it.',
        support: SUPPORT,
      },
      EXIT_ERROR,
    );
  }

  // The send window was judged on the snapshot. Re-judge it now against the
  // payment we are about to show: its deadline may be earlier, or the clock
  // may have crossed the safety margin in between. The earlier snapshot
  // deadline (Coinbase / Bitrefill) still bounds it.
  const finalWindow = checkExpiry({
    now: Date.now(),
    chainId: source.chainId,
    intentExpiresAt: payment?.expiresAt ?? snap.sendWindow?.deadlineMs,
    coinbaseExpiry: snap.sendWindow?.deadlineMs,
  });
  if (!finalWindow.ok) {
    emit(
      {
        success: false,
        step: 'resume',
        resumable: false,
        outcome: 'expired',
        rozoPaymentId: id,
        moneyDetected: false,
        error: { code: finalWindow.code, message: finalWindow.reason },
        guidance: 'Not enough time is left to pay this order safely. Do not fund it; let it expire unfunded and create a new order.',
        support: SUPPORT,
      },
      EXIT_ERROR,
    );
  }

  const lightning = String(source.chainId) === 'lightning';
  if (!lightning) {
    try {
      assertNotBlacklisted(
        [{ address: source.receiverAddress, family: chainFamily(source.chainId), role: 'deposit address' }],
        blacklist,
      );
    } catch (err) {
      emit(
        {
          success: false,
          step: 'resume',
          resumable: false,
          rozoPaymentId: id,
          error: { code: err.code, message: err.message },
          guidance: 'Do NOT send anything. Report this to the operator immediately.',
          support: SUPPORT,
        },
        EXIT_ERROR,
      );
    }
  }

  const expiresAt = payment?.expiresAt ?? snap.expiry?.expiresAt ?? null;
  const msRemaining = expiresAt ? Date.parse(expiresAt) - Date.now() : NaN;
  const expiresIn = Number.isFinite(msRemaining) ? formatRemaining(msRemaining) : null;
  const paymentLink = payment?.paymentLink ?? localPaymentLink(id);
  const bolt11 = source.lnInvoice ?? payment?.lnInvoice ?? null;

  emit({
    success: true,
    step: 'resume',
    resumable: true,
    outcome: 'awaiting_deposit',
    confirmed,
    rozoPaymentId: id,
    linkId: snap.linkId ?? payment?.orderId ?? null,
    provider: snap.provider,
    state: snap.state,
    // Hosted pay page for this order: a human can open it and pay from there.
    // Shown in full only for Rozo's own pay-page hosts; anything else is
    // reduced to its host by the normal output redaction.
    paymentLink: publicPayPage(paymentLink),
    deposit: confirmed
      ? {
          chainId: source.chainId,
          chain: chainName(source.chainId),
          tokenSymbol: source.tokenSymbol,
          tokenAddress: source.tokenAddress || null,
          receiverAddress: lightning ? null : source.receiverAddress,
          receiverMemo: source.receiverMemo ?? null,
          receiverMemoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
          amount: source.amount,
          amountUnit: source.amountUnit ?? null,
          isSats: isSatsUnit(source.amountUnit),
          lnInvoice: bolt11 || null,
          payTo: guard.deposit.payTo,
          expiresAt,
          expiresIn,
        }
      : null,
    depositWithheld: !confirmed,
    display: {
      chain: chainName(source.chainId),
      token: source.tokenSymbol,
      amount: formatAmount(source),
      isSats: isSatsUnit(source.amountUnit),
      payToMasked: maskAddress(guard.deposit.payTo),
      receiverMemoMasked: maskMemo(source.receiverMemo),
      hasMemo: Boolean(source.receiverMemo),
      memoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
    },
    expiry: { expiresAt, expiresIn, minutesOfSlack: snap.sendWindow?.minutesOfSlack ?? null },
    note: confirmed
      ? 'Send exactly once, exactly this amount, on this chain. Then: rozo-checkout status <id> --watch'
      : 'Deposit address withheld. Confirm the chain, token and amount with the payer, then re-run with --confirm, or open paymentLink.',
  });
}

/** Entry point for the standalone script and the CLI (see status.mjs). */
export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
