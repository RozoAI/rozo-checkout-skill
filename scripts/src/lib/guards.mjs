/**
 * Pure decision functions for the PLAN §3 abort conditions.
 *
 * Every one of these returns a verdict object rather than printing, so the
 * scripts stay thin and the tests can exercise the rails offline.
 *
 * Error codes produced here (all are hard aborts):
 *   REUSED_SOURCE_MISMATCH   returned chain/token != the user's confirmed choice
 *   ORDER_ALREADY_FUNDED     the intent already shows money (money-detected rule)
 *   CREATE_DRIFT             create response disagrees with the quoted snapshot
 *   LINK_NO_LONGER_PAYABLE   Coinbase resource used / expired / non-payable
 *   DEPOSIT_NOT_LIVE         deposit address did not come from this run's GET
 *   NO_DISCOUNT_VIOLATION    callerPays != original, or discount != "0"
 */

import { comparePayment } from './amounts.mjs';

/** Statuses that mean "nothing has been funded yet". */
export const UNPAID_STATUS = 'payment_unpaid';

/**
 * Reuse guard (PLAN §3 step 5, fix P0-4 / R2-4).
 *
 * create-invoice reuses ANY unexpired intent keyed by the Coinbase link —
 * reuse requires only existence + not-expired, NOT that it is unpaid. So on
 * every run (not only when `reused` is true) we GET payments/<rozoPaymentId>
 * and require ALL of:
 *   status == payment_unpaid, source.txHash == null,
 *   source.amountReceived null/zero, source.confirmedAt == null
 * and require the returned source to match the user's confirmed choice.
 *
 * @param {object} args
 * @param {object} args.payment    payments/<id> GET response
 * @param {object} args.requested  { chainId, tokenSymbol } the user confirmed
 * @param {boolean} [args.reused]  create response `reused` flag (reporting only)
 * @returns {{ok:boolean, code:string|null, reason:string|null,
 *            moneyDetected:boolean, evidence:object}}
 */
export function reuseGuard({ payment, requested, reused = false }) {
  const source = payment?.source || {};
  const evidence = {
    reused: Boolean(reused),
    status: payment?.status ?? null,
    txHash: source.txHash ?? null,
    amountReceived: source.amountReceived ?? null,
    confirmedAt: source.confirmedAt ?? null,
    chainId: source.chainId ?? null,
    tokenSymbol: source.tokenSymbol ?? null,
    senderAddress: source.senderAddress ?? null,
  };

  // 1. Money-detected first: this outranks everything, including a mismatch,
  //    because the response must never advise paying again.
  const hasTx = source.txHash !== null && source.txHash !== undefined && source.txHash !== '';
  let received = null;
  try {
    received = comparePayment(source);
  } catch {
    received = null;
  }
  const hasReceipt = received !== null && received.state !== 'none';
  const hasConfirm =
    source.confirmedAt !== null && source.confirmedAt !== undefined && source.confirmedAt !== '';
  if (hasTx || hasReceipt || hasConfirm) {
    return {
      ok: false,
      code: 'ORDER_ALREADY_FUNDED',
      reason:
        'This Coinbase link already has a funded Rozo order (it may have been paid ' +
        'elsewhere). Do NOT pay again — escalate for manual reconciliation.',
      moneyDetected: true,
      evidence: { ...evidence, receipt: received },
    };
  }

  // 2. Status must be exactly payment_unpaid.
  if (payment?.status !== UNPAID_STATUS) {
    const terminal = ['payment_expired', 'payment_bounced', 'payment_refunded'].includes(
      payment?.status,
    );
    return {
      ok: false,
      code: terminal ? 'ORDER_NOT_PAYABLE' : 'ORDER_ALREADY_FUNDED',
      reason: `Existing order status is "${payment?.status ?? 'unknown'}", not "${UNPAID_STATUS}".`,
      moneyDetected: !terminal,
      evidence,
    };
  }

  // 3. Source must match the user's confirmed choice exactly.
  const wantChain = String(requested?.chainId ?? '').trim();
  const wantToken = String(requested?.tokenSymbol ?? '').trim().toUpperCase();
  const gotChain = String(source.chainId ?? '').trim();
  const gotToken = String(source.tokenSymbol ?? '').trim().toUpperCase();
  if (!gotChain || !gotToken || gotChain !== wantChain || gotToken !== wantToken) {
    return {
      ok: false,
      code: 'REUSED_SOURCE_MISMATCH',
      reason:
        `The order expects ${gotToken || '?'} on chain ${gotChain || '?'}, but you chose ` +
        `${wantToken} on chain ${wantChain}. Paying the wrong asset or network is ` +
        'usually unrecoverable.',
      moneyDetected: false,
      evidence,
    };
  }

  // 4. There must actually be a deposit address to pay.
  if (!source.receiverAddress) {
    return {
      ok: false,
      code: 'DEPOSIT_NOT_LIVE',
      reason: 'The live payments GET returned no deposit address.',
      moneyDetected: false,
      evidence,
    };
  }

  return { ok: true, code: null, reason: null, moneyDetected: false, evidence };
}

/**
 * Post-create verification (PLAN §3 step 4): the create response must agree
 * with the pre-create quoted snapshot. Any drift stops the run.
 */
export function verifyCreateAgainstQuote({ snapshot, created, requested }) {
  const drift = [];
  const cmp = (field, a, b, normalize = (v) => (v === null || v === undefined ? null : String(v))) => {
    const na = normalize(a);
    const nb = normalize(b);
    if (na !== null && nb !== null && na !== nb) drift.push({ field, quoted: na, created: nb });
  };

  cmp('linkId', snapshot?.linkId, created?.linkId);
  cmp('merchant', snapshot?.merchant, created?.merchant);
  cmp('original', snapshot?.original, created?.original, normalizeDecimal);
  cmp('callerPays', snapshot?.callerPays, created?.callerPays, normalizeDecimal);

  // Requested source must be echoed exactly.
  const wantChain = String(requested?.chainId ?? '').trim();
  const wantToken = String(requested?.tokenSymbol ?? '').trim().toUpperCase();
  const gotChain = String(created?.source?.chainId ?? '').trim();
  const gotToken = String(created?.source?.tokenSymbol ?? '').trim().toUpperCase();
  if (gotChain !== wantChain) drift.push({ field: 'source.chainId', quoted: wantChain, created: gotChain });
  if (gotToken !== wantToken) {
    drift.push({ field: 'source.tokenSymbol', quoted: wantToken, created: gotToken });
  }

  if (drift.length) {
    return {
      ok: false,
      code: 'CREATE_DRIFT',
      reason: 'The created order does not match what was quoted. Refusing to continue.',
      drift,
    };
  }

  // No-discount invariant (PLAN §1, fix P0-1): on the OpenRouter/Coinbase line
  // callerPays == original and discount == "0". Anything else means we are
  // reading a different code path than the one this skill was built for.
  const disc = created?.discount;
  if (disc !== undefined && disc !== null && normalizeDecimal(disc) !== '0') {
    return {
      ok: false,
      code: 'NO_DISCOUNT_VIOLATION',
      reason: `Server reported a discount of "${disc}"; this flow must charge the full invoice.`,
      drift: [{ field: 'discount', quoted: '0', created: String(disc) }],
    };
  }
  if (
    created?.callerPays !== undefined &&
    created?.original !== undefined &&
    normalizeDecimal(created.callerPays) !== normalizeDecimal(created.original)
  ) {
    return {
      ok: false,
      code: 'NO_DISCOUNT_VIOLATION',
      reason: `callerPays (${created.callerPays}) differs from the invoice amount (${created.original}).`,
      drift: [
        { field: 'callerPays', quoted: String(created.original), created: String(created.callerPays) },
      ],
    };
  }

  return { ok: true, code: null, reason: null, drift: [] };
}

/** "1.50" and "1.5" and "1.500000" are the same money. */
export function normalizeDecimal(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const [w, f = ''] = s.split('.');
  const frac = f.replace(/0+$/, '');
  const whole = w.replace(/^0+(?=\d)/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Payability revalidation (PLAN §3, fix R2-new-P0). Derived from the
 * invoice-status `coinbase` block, which has no `payable` key of its own.
 *
 * @param {object} statusResponse invoice-status response
 * @param {number} now epoch ms
 */
export function checkPayable(statusResponse, now = Date.now()) {
  const cb = statusResponse?.coinbase;
  if (!cb) {
    return {
      ok: false,
      code: 'LINK_NO_LONGER_PAYABLE',
      reason: 'invoice-status returned no Coinbase state; cannot prove the link is still payable.',
      derived: null,
    };
  }
  const protocolVersion = cb.protocolVersion ?? statusResponse?.protocolVersion ?? null;
  const derived = {
    protocolVersion,
    status: cb.status ?? null,
    settled: cb.settled ?? null,
    usageCount: cb.usageCount ?? null,
    maxUsage: cb.maxUsage ?? null,
    preApprovalExpiry: cb.preApprovalExpiry ?? null,
  };

  if (cb.settled === true) {
    return {
      ok: false,
      code: 'LINK_NO_LONGER_PAYABLE',
      reason: 'The Coinbase resource is already settled — someone has paid it.',
      derived,
    };
  }
  if (protocolVersion === 'v3' && cb.status && cb.status !== 'PAYMENT_SESSION_STATUS_CREATED') {
    return {
      ok: false,
      code: 'LINK_NO_LONGER_PAYABLE',
      reason: `Payment Session status is ${cb.status}; only PAYMENT_SESSION_STATUS_CREATED is payable.`,
      derived,
    };
  }
  if (cb.usageCount !== null && cb.usageCount !== undefined) {
    const max = cb.maxUsage ?? 1;
    if (Number(cb.usageCount) >= Number(max)) {
      return {
        ok: false,
        code: 'LINK_NO_LONGER_PAYABLE',
        reason: `Payment link already used (${cb.usageCount}/${max}).`,
        derived,
      };
    }
  }
  return { ok: true, code: null, reason: null, derived };
}

/**
 * Status taxonomy for step 7 (PLAN §3, fix P1-7). Combines the Rozo intent
 * status with the mpprouter fulfillment state and the money-detected rule.
 *
 * @returns {{state:string, moneyDetected:boolean, terminal:boolean,
 *            escalate:boolean, detail:string}}
 */
export function classifyStatus({ payment, routerState, coinbase, now = Date.now() }) {
  const source = payment?.source || {};
  const hasTx = Boolean(source.txHash);
  const confirmed = Boolean(source.confirmedAt);
  let receipt = null;
  try {
    receipt = comparePayment(source);
  } catch {
    receipt = null;
  }
  const moneyDetected = hasTx || confirmed || (receipt && receipt.state !== 'none');
  const routerStatus = routerState?.status ?? null;

  const mk = (state, detail, opts = {}) => ({
    state,
    moneyDetected: Boolean(moneyDetected),
    terminal: Boolean(opts.terminal),
    escalate: Boolean(opts.escalate),
    detail,
    receipt,
    routerStatus,
  });

  // Terminal success first.
  if (routerStatus === 'paid' || coinbase?.settled === true) {
    return mk('settled', 'Coinbase invoice settled by the funder wallet.', { terminal: true });
  }
  if (routerStatus === 'failed_pay_invoice' || routerStatus === 'failed_insufficient_balance') {
    return mk(
      'stuck_after_payment',
      `Fulfillment failed (${routerStatus}) after the pay-in. Do not pay again — escalate for ` +
        'manual reconciliation.',
      { terminal: false, escalate: true },
    );
  }

  if (moneyDetected && receipt && receipt.state === 'underpaid') {
    return mk(
      'underpaid',
      'Less arrived than the order requires. Do NOT send a top-up to the same address — escalate.',
      { escalate: true },
    );
  }
  if (moneyDetected && receipt && receipt.state === 'overpaid') {
    return mk('payin_detected', 'More arrived than required; escalate for operator follow-up.', {
      escalate: true,
    });
  }

  switch (payment?.status) {
    case 'payment_unpaid': {
      if (moneyDetected) {
        return mk('payin_detected', 'Pay-in seen on chain, waiting for confirmations.');
      }
      const exp = payment?.expiresAt ? Date.parse(payment.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp < now) {
        return mk('expired_unfunded', 'The order expired before any funds arrived. Safe to retry.', {
          terminal: true,
        });
      }
      return mk('awaiting_deposit', 'Waiting for the deposit.');
    }
    case 'payment_started':
      return mk('payin_detected', 'Pay-in seen, waiting for confirmations.');
    case 'payment_payin_completed':
      return mk('payin_confirmed', 'Pay-in confirmed; fulfillment can start.');
    case 'payment_bridging':
    case 'payment_payout_started':
      return mk('bridging', 'Bridging the pay-in toward the funder.');
    case 'payment_payout_completed':
      return mk(
        routerStatus === 'paying' ? 'paying_coinbase' : 'bridging',
        routerStatus === 'paying'
          ? 'Funder is paying the Coinbase invoice.'
          : 'Payout landed; waiting on Coinbase settlement.',
      );
    case 'payment_completed':
      return mk('settled', 'Rozo payment completed.', { terminal: true });
    case 'payment_expired':
      return moneyDetected
        ? mk('stuck_after_payment', 'Order expired AFTER funds arrived — escalate immediately.', {
            escalate: true,
          })
        : mk('expired_unfunded', 'Order expired unfunded. Safe to retry.', { terminal: true });
    case 'payment_bounced':
    case 'payment_refunded':
      return mk('stuck_after_payment', `Order ended as ${payment.status} — escalate.`, {
        escalate: true,
      });
    default:
      break;
  }

  if (routerStatus === 'payin_seen') return mk('payin_confirmed', 'Router saw the pay-in.');
  if (routerStatus === 'paying') return mk('paying_coinbase', 'Funder is paying Coinbase.');

  return mk(
    moneyDetected ? 'stuck_after_payment' : 'awaiting_deposit',
    `Unrecognized backend status "${payment?.status ?? 'unknown'}".`,
    { escalate: Boolean(moneyDetected) },
  );
}
