#!/usr/bin/env node
/**
 * status.js — step 7. READ-ONLY.
 *
 *   node scripts/dist/status.js --rozo-payment-id <uuid>
 *   node scripts/dist/status.js --link-id pl_01...
 *   node scripts/dist/status.js --rozo-payment-id <uuid> --watch --timeout 600
 *
 * Polls both views — the router's fulfillment view (invoice-status) and the
 * pay-in/payout view (payments/<id>) — and maps them onto one taxonomy:
 *
 *   awaiting_deposit | payin_detected | payin_confirmed | bridging |
 *   paying_coinbase  | settled | expired_unfunded | underpaid |
 *   stuck_after_payment
 *
 * Money-detected rule: once any pay-in exists, this never reports a plain
 * failure and never suggests paying again.
 */

import { parseArgs, emit, fail, usage, EXIT_UNCONFIRMED, EXIT_ERROR } from './lib/output.mjs';
import { isRozoPaymentId, maskAddress } from './lib/ids.mjs';
import { invoiceStatus, getPayment } from './lib/api.mjs';
import { chainName, formatAmount } from './lib/amounts.mjs';
import { classifyStatus } from './lib/guards.mjs';
import { formatRemaining } from './lib/expiry.mjs';
import { findByLinkId } from './lib/state.mjs';

const POLL_INTERVAL_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot({ rozoPaymentId, linkId }) {
  let status = null;
  let statusError = null;
  try {
    status = await invoiceStatus({ linkId, rozoPaymentId });
  } catch (err) {
    statusError = { code: err.code, message: err.message };
  }

  // The backend only echoes rozo_payment_id when it was given one (a
  // link-only query does not resolve it), so fall back to the local record
  // written at create time. Without an id there is no authoritative pay-in
  // view and the money-detected rule cannot be enforced.
  let id = rozoPaymentId || status?.rozo_payment_id || null;
  let idSource = rozoPaymentId ? 'argument' : status?.rozo_payment_id ? 'invoice-status' : null;
  if (!id && linkId) {
    const local = findByLinkId(linkId);
    if (local) {
      id = local.rozoPaymentId;
      idSource = 'local state';
    }
  }

  let payment = null;
  let paymentError = null;
  if (id && isRozoPaymentId(id)) {
    try {
      payment = await getPayment(id);
    } catch (err) {
      paymentError = { code: err.code, message: err.message };
    }
  }

  const viewsFailed = Boolean(statusError) && !payment;
  const verdict = classifyStatus({
    payment: payment || status?.rozoPayment || {},
    routerState: status?.routerState,
    coinbase: status?.coinbase,
    viewsFailed,
  });

  const source = payment?.source || status?.rozoPayment?.source || {};

  return {
    rozoPaymentId: id,
    rozoPaymentIdSource: idSource,
    // Without the authoritative payment object we are reading a partial view.
    authoritativeView: Boolean(payment),
    linkId: linkId || status?.pl_id || null,
    state: verdict.state,
    unknown: verdict.unknown,
    moneyDetected: verdict.moneyDetected,
    terminal: verdict.terminal,
    escalate: verdict.escalate,
    detail: verdict.detail,
    backend: {
      paymentStatus: payment?.status ?? status?.rozoPayment?.status ?? null,
      routerStatus: verdict.routerStatus,
      coinbaseSettled: status?.coinbase?.settled ?? null,
      coinbaseStatus: status?.coinbase?.status ?? null,
    },
    payin: {
      expected: source.amount ? formatAmount(source) : null,
      received: source.amountReceived ?? null,
      receipt: verdict.receipt,
      txHash: source.txHash ?? null,
      confirmedAt: source.confirmedAt ?? null,
      senderAddressMasked: source.senderAddress ? maskAddress(source.senderAddress) : null,
      chain: source.chainId ? chainName(source.chainId) : null,
    },
    expiry: (() => {
      const iso = payment?.expiresAt ?? status?.rozoPayment?.expiresAt ?? null;
      if (!iso) return { expiresAt: null, expiresIn: null, msRemaining: null };
      const ms = Date.parse(iso) - Date.now();
      return {
        expiresAt: iso,
        expiresIn: formatRemaining(ms),
        msRemaining: Number.isFinite(ms) ? ms : null,
      };
    })(),
    payout: {
      txHash: payment?.destination?.txHash ?? status?.rozoPayment?.destination?.txHash ?? null,
      confirmedAt:
        payment?.destination?.confirmedAt ?? status?.rozoPayment?.destination?.confirmedAt ?? null,
    },
    errors: [statusError, paymentError].filter(Boolean),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = args['rozo-payment-id'] || (isRozoPaymentId(args._[0]) ? args._[0] : null);
  const linkId = args['link-id'] || (!rozoPaymentId ? args._[0] : null);
  if (!rozoPaymentId && !linkId) {
    usage('Required: --rozo-payment-id <uuid> and/or --link-id <pl_* | paymentSession_*>');
  }

  const watch = Boolean(args.watch);
  const timeoutMs = Math.max(0, Number(args.timeout ?? 600) * 1000);
  const deadline = Date.now() + timeoutMs;

  let result = await snapshot({ rozoPaymentId, linkId });
  const history = [{ at: new Date().toISOString(), state: result.state }];

  while (watch && !result.terminal && !result.escalate && !result.unknown && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const next = await snapshot({ rozoPaymentId: result.rozoPaymentId || rozoPaymentId, linkId });
    if (next.state !== result.state) history.push({ at: new Date().toISOString(), state: next.state });
    result = next;
  }

  const guidance = result.escalate
    ? 'MONEY DETECTED and the order is not on a healthy path. Do NOT pay again and do NOT create ' +
      'a new order for this link. Preserve linkId, rozoPaymentId and every tx hash, then escalate ' +
      'to the operator for manual reconciliation.'
    : result.unknown
      ? 'The order state could not be established. This is NOT evidence that nothing was paid — ' +
        'do not create a new order and do not send again on the strength of it. Retry, or pass ' +
        '--rozo-payment-id so the authoritative pay-in view can be read.'
      : !result.authoritativeView
        ? 'Only the fulfilment view was readable; the pay-in view is unavailable, so the ' +
          'money-detected rule cannot be enforced. Pass --rozo-payment-id for a complete answer.'
        : result.state === 'expired_unfunded'
          ? 'Nothing was funded, so nothing was lost. Start a fresh order with: ' +
            'rozo-checkout pay <coinbase-link> --with <coin>  (or create-order.js ' +
            '--url <link> --chain <id> --token <SYMBOL>)'
          : result.terminal
            ? 'Done.'
            : 'Still in flight. Poll again in ~10s.';

  const unresolved = watch && !result.terminal && !result.escalate && !result.unknown;
  const failed = result.escalate || result.unknown || !result.authoritativeView;

  emit(
    {
      success: !failed,
      step: 'status',
      ...result,
      history,
      guidance,
      timedOut: unresolved,
    },
    failed ? EXIT_ERROR : unresolved ? EXIT_UNCONFIRMED : 0,
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
