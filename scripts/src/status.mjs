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

import { parseArgs, emit, fail, usage, EXIT_UNCONFIRMED } from './lib/output.mjs';
import { isRozoPaymentId, maskAddress } from './lib/ids.mjs';
import { invoiceStatus, getPayment } from './lib/api.mjs';
import { chainName, formatAmount } from './lib/amounts.mjs';
import { classifyStatus } from './lib/guards.mjs';

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

  const id = rozoPaymentId || status?.rozo_payment_id || null;
  let payment = null;
  let paymentError = null;
  if (id && isRozoPaymentId(id)) {
    try {
      payment = await getPayment(id);
    } catch (err) {
      paymentError = { code: err.code, message: err.message };
    }
  }

  const verdict = classifyStatus({
    payment: payment || status?.rozoPayment || {},
    routerState: status?.routerState,
    coinbase: status?.coinbase,
  });

  const source = payment?.source || status?.rozoPayment?.source || {};

  return {
    rozoPaymentId: id,
    linkId: linkId || status?.pl_id || null,
    state: verdict.state,
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
    payout: {
      txHash: payment?.destination?.txHash ?? status?.rozoPayment?.destination?.txHash ?? null,
      confirmedAt:
        payment?.destination?.confirmedAt ?? status?.rozoPayment?.destination?.confirmedAt ?? null,
    },
    errors: [statusError, paymentError].filter(Boolean),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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

  while (watch && !result.terminal && !result.escalate && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const next = await snapshot({ rozoPaymentId: result.rozoPaymentId || rozoPaymentId, linkId });
    if (next.state !== result.state) history.push({ at: new Date().toISOString(), state: next.state });
    result = next;
  }

  const guidance = result.escalate
    ? 'MONEY DETECTED and the order is not on a healthy path. Do NOT pay again and do NOT create ' +
      'a new order for this link. Preserve linkId, rozoPaymentId and every tx hash, then escalate ' +
      'to the operator for manual reconciliation.'
    : result.state === 'expired_unfunded'
      ? 'Nothing was funded. It is safe to start over with a fresh link.'
      : result.terminal
        ? 'Done.'
        : 'Still in flight. Poll again in ~10s.';

  const unresolved = watch && !result.terminal && !result.escalate;

  emit(
    {
      success: !result.escalate,
      step: 'status',
      ...result,
      history,
      guidance,
      timedOut: unresolved,
    },
    unresolved ? EXIT_UNCONFIRMED : 0,
  );
}

main().catch((err) => fail(err));
