/**
 * Payment outcome, next action and the three-layer receipt.
 *
 * Pure: no I/O. It reads a status snapshot (see status.mjs) and answers three
 * questions an integrator actually has, separately:
 *
 *   1. sourcePayment       did the payer's money reach Rozo?
 *   2. merchantSettlement  was the merchant invoice (Coinbase / Bitrefill) paid?
 *   3. serviceDelivery     did the merchant deliver (e.g. OpenRouter credits)?
 *
 * Rules that protect money:
 *   - Coinbase settlement is proved ONLY by the Coinbase resource itself
 *     (v3 PAYMENT_SESSION_STATUS_CAPTURE_SUCCEEDED, v1 usageCount >= maxUsage,
 *     both surfaced by the router as coinbase.settled). The router's own
 *     `paid` means its pay-invoice call returned OK, which for v3 can precede
 *     capture, so on its own it stays `processing`.
 *   - Once money is detected, a local send exists, the pay-in view is partial
 *     or the state is unknown, no field here ever permits paying again.
 *   - serviceDelivery is never inferred from settlement. Nothing in this
 *     codebase observes credit delivery, so it is always `unknown`.
 */

export const SCHEMA_VERSION = 1;

export const PAYMENT_OUTCOMES = Object.freeze([
  'awaiting_payment',
  'processing',
  'settled',
  'expired_unfunded',
  'needs_attention',
  'unknown',
]);

export const NEXT_ACTION_TYPES = Object.freeze([
  'pay',
  'check_status',
  'choose_method',
  'request_new_invoice',
  'contact_support',
  'none',
]);

/**
 * Explicit state -> outcome table. A state that is not listed maps to
 * `unknown`; a new backend state must be added here deliberately.
 */
export const STATE_TO_OUTCOME = Object.freeze({
  awaiting_deposit: 'awaiting_payment',
  payin_detected: 'processing',
  payin_confirmed: 'processing',
  bridging: 'processing',
  paying_coinbase: 'processing',
  settled: 'settled',
  expired_unfunded: 'expired_unfunded',
  invoice_expired: 'expired_unfunded',
  deadline_unknown: 'needs_attention',
  underpaid: 'needs_attention',
  stuck_after_payment: 'needs_attention',
  unknown: 'unknown',
});

const SERVICE_DELIVERY_NOTE = {
  coinbase:
    'The invoice is paid. Arrival of the OpenRouter credits (or other goods) is not independently ' +
    'verified by Rozo; check the merchant account.',
  bitrefill:
    'USDC reached the Bitrefill invoice address. Delivery of the Bitrefill order is not ' +
    'independently verified by Rozo; check the Bitrefill order page.',
};

/** True when the merchant leg is proved by the merchant-side resource itself. */
export function merchantSettlementProved(result) {
  if (result?.provider === 'bitrefill') return result?.state === 'settled';
  return result?.backend?.coinbaseSettled === true;
}

/** A local send record that is not a clean, provable "nothing left this machine". */
export function hasLocalSend(result) {
  return Boolean(result?.localSend && result.localSend.status);
}

export function paymentOutcomeFor(result) {
  if (!result) return 'unknown';
  if (result.escalate) return 'needs_attention';
  if (result.unknown) return 'unknown';

  let outcome = Object.prototype.hasOwnProperty.call(STATE_TO_OUTCOME, result.state)
    ? STATE_TO_OUTCOME[result.state]
    : 'unknown';

  // Router said paid, Coinbase has not shown capture yet.
  if (outcome === 'settled' && !merchantSettlementProved(result)) outcome = 'processing';

  // A partial view cannot tell "nothing paid" from "paid, not visible".
  if (!result.authoritativeView && (outcome === 'awaiting_payment' || outcome === 'expired_unfunded')) {
    return 'unknown';
  }

  // Money or a local send on an order that looks unpaid/expired is never a
  // clean state: it is a payment we cannot account for yet.
  if ((result.moneyDetected || hasLocalSend(result)) && outcome === 'expired_unfunded') {
    return 'needs_attention';
  }
  if (result.moneyDetected && outcome === 'awaiting_payment') return 'processing';
  return outcome;
}

/**
 * What the caller may do next. `canSend` is the only flag that permits moving
 * money, and it is true only for a clean, authoritative, unfunded, live order
 * with no local send record.
 */
export function nextActionFor(result, outcome = paymentOutcomeFor(result)) {
  const locked = Boolean(result?.moneyDetected) || hasLocalSend(result);
  const base = { canRetryQuery: true, canCreateOrder: false, canSend: false };
  const bitrefill = result?.provider === 'bitrefill';

  switch (outcome) {
    case 'awaiting_payment':
      if (locked) {
        return {
          ...base,
          type: 'check_status',
          message:
            'A send was already recorded for this order. Do NOT pay again; poll status until the ' +
            'pay-in shows up.',
        };
      }
      return {
        ...base,
        type: 'pay',
        canSend: true,
        message: 'Send the exact amount from the order deposit block, once.',
      };
    case 'processing':
      return {
        ...base,
        type: 'check_status',
        message: 'Funds are moving. Do NOT pay again; poll status.',
      };
    case 'settled':
      return { ...base, type: 'none', canRetryQuery: false, message: 'Nothing to do.' };
    case 'expired_unfunded':
      if (bitrefill) {
        return {
          ...base,
          type: 'request_new_invoice',
          message: 'Nothing was funded. Create a fresh Bitrefill invoice and pay that one.',
        };
      }
      return {
        ...base,
        type: 'choose_method',
        canCreateOrder: true,
        message:
          'Nothing arrived for this order. If your own wallet shows no send to the old deposit ' +
          'address and no pending Lightning payment, run pay again on the same link: it creates ' +
          'a new order, and you may pick a different coin. Never fund the old deposit address.',
      };
    case 'needs_attention':
      if (result?.state === 'deadline_unknown' && !locked) {
        return {
          ...base,
          type: 'request_new_invoice',
          message:
            'The invoice deadline is unknown here, so the order is not payable. Re-run pay with ' +
            'the invoice details, or create a fresh invoice.',
        };
      }
      return {
        ...base,
        type: 'contact_support',
        message:
          'Do NOT pay again and do NOT create a new order. Keep linkId, rozoPaymentId and every ' +
          'tx hash, and contact Rozo support.',
      };
    default:
      return {
        ...base,
        type: 'check_status',
        message:
          'The order state could not be established. This is not evidence that nothing was ' +
          'paid. Retry with the rozoPaymentId before doing anything else.',
      };
  }
}

function sourcePaymentLayer(result) {
  const payin = result?.payin || {};
  let status;
  if (result?.unknown || !result?.authoritativeView) status = 'unknown';
  else if (payin.confirmedAt) status = 'confirmed';
  else if (result?.moneyDetected) status = 'detected';
  else status = 'none';
  return {
    status,
    evidence: status === 'unknown' ? null : 'rozo-intents',
    chain: payin.chain ?? null,
    expected: payin.expected ?? null,
    received: payin.received ?? null,
    txHash: payin.txHash ?? null,
    confirmedAt: payin.confirmedAt ?? null,
    localSend: result?.localSend
      ? {
          status: result.localSend.status,
          txHash: result.localSend.txHash ?? null,
          claimedAt: result.localSend.claimedAt ?? null,
          // A wallet broadcast proves the payer sent, not that Rozo received.
          evidence: 'local-wallet',
        }
      : null,
  };
}

function merchantSettlementLayer(result) {
  if (result?.provider === 'bitrefill') {
    const proved = result?.state === 'settled';
    return {
      status: proved ? 'confirmed' : result?.unknown ? 'unknown' : 'pending',
      evidence: proved ? 'rozo-payout' : null,
      provider: 'bitrefill',
      txHash: result?.payout?.txHash ?? null,
      confirmedAt: result?.payout?.confirmedAt ?? null,
    };
  }
  const backend = result?.backend || {};
  let status;
  if (backend.coinbaseSettled === true) status = 'confirmed';
  else if (backend.coinbaseSettled === null || backend.coinbaseSettled === undefined) {
    status = backend.routerStatus === 'paid' || result?.unknown ? 'unknown' : 'pending';
  } else status = 'pending';
  return {
    status,
    evidence: status === 'confirmed' ? 'coinbase' : null,
    provider: 'coinbase',
    coinbaseStatus: backend.coinbaseStatus ?? null,
    routerStatus: backend.routerStatus ?? null,
    // The router reporting `paid` is recorded, but it is not settlement proof.
    routerReportsPaid: backend.routerStatus === 'paid',
    payoutTxHash: result?.payout?.txHash ?? null,
  };
}

function serviceDeliveryLayer(result, merchant) {
  return {
    status: 'unknown',
    evidence: null,
    note:
      merchant.status === 'confirmed'
        ? SERVICE_DELIVERY_NOTE[result?.provider === 'bitrefill' ? 'bitrefill' : 'coinbase']
        : 'Not applicable until the merchant invoice is settled.',
  };
}

export function buildReceipt(result, { observedAt = new Date().toISOString() } = {}) {
  const paymentOutcome = paymentOutcomeFor(result);
  const merchantSettlement = merchantSettlementLayer(result);
  return {
    schemaVersion: SCHEMA_VERSION,
    orderId: result?.rozoPaymentId ?? null,
    linkId: result?.linkId ?? null,
    provider: result?.provider ?? null,
    observedAt,
    paymentOutcome,
    state: result?.state ?? 'unknown',
    sourcePayment: sourcePaymentLayer(result),
    merchantSettlement,
    serviceDelivery: serviceDeliveryLayer(result, merchantSettlement),
    nextAction: nextActionFor(result, paymentOutcome),
  };
}

/**
 * `receipt` exit codes: 0 settled, 3 not finished or unknown, 1 definitely
 * not paid or needs a human. (2 is usage, raised before this is reached.)
 */
export function receiptExitCode(outcome) {
  if (outcome === 'settled') return 0;
  if (outcome === 'expired_unfunded' || outcome === 'needs_attention') return 1;
  return 3;
}
