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
import { SUPPORT } from './lib/support.mjs';
import { formatRemaining } from './lib/expiry.mjs';
import { findByLinkId, readState } from './lib/state.mjs';
import { providerFromPayment, earliestExpiry, intentBitrefillExpiry } from './lib/bitrefill.mjs';

const POLL_INTERVAL_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Provider from the flag, else from this machine's order record. */
function resolveProvider(explicit, rozoPaymentId) {
  if (explicit) return String(explicit).toLowerCase();
  if (rozoPaymentId && isRozoPaymentId(rozoPaymentId)) {
    try {
      return readState(rozoPaymentId)?.provider ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function snapshot({ rozoPaymentId, linkId, provider: explicitProvider }) {
  let provider = resolveProvider(explicitProvider, rozoPaymentId);
  // No flag and no local record: ask the intent itself first, so a Bitrefill
  // order created elsewhere is still classified correctly.
  let prefetched = null;
  if (!provider && rozoPaymentId && isRozoPaymentId(rozoPaymentId)) {
    try {
      prefetched = await getPayment(rozoPaymentId);
      provider = providerFromPayment(prefetched);
    } catch {
      prefetched = null;
    }
  }
  provider = provider === 'bitrefill' ? 'bitrefill' : 'coinbase';
  let status = null;
  let statusError = null;
  // A Bitrefill order has no Coinbase resource and no router fulfilment
  // state; the intent alone is authoritative.
  if (provider !== 'bitrefill') {
    try {
      status = await invoiceStatus({ linkId, rozoPaymentId });
    } catch (err) {
      statusError = { code: err.code, message: err.message };
    }
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
  if (prefetched && id === rozoPaymentId) {
    payment = prefetched;
  } else if (id && isRozoPaymentId(id)) {
    try {
      payment = await getPayment(id);
    } catch (err) {
      paymentError = { code: err.code, message: err.message };
    }
  }

  const viewsFailed = provider === 'bitrefill' ? !payment : Boolean(statusError) && !payment;
  const verdict = classifyStatus({
    payment: payment || status?.rozoPayment || {},
    routerState: status?.routerState,
    coinbase: status?.coinbase,
    viewsFailed,
    provider,
  });

  const source = payment?.source || status?.rozoPayment?.source || {};

  // Bitrefill: the invoice deadline is the only clock. Unknown → never call
  // the order payable; past → invoice_expired (unless money already moved).
  let bitrefillExpiry = null;
  let state = verdict.state;
  let terminal = verdict.terminal;
  let detail = verdict.detail;
  if (provider === 'bitrefill') {
    let local = null;
    try {
      local = id && isRozoPaymentId(id) ? readState(id) : null;
    } catch {
      local = null;
    }
    bitrefillExpiry = earliestExpiry(local?.bitrefill?.expiresAt, intentBitrefillExpiry(payment));
    if (!verdict.moneyDetected && ['awaiting_deposit', 'expired_unfunded'].includes(verdict.state)) {
      const ms = bitrefillExpiry ? Date.parse(bitrefillExpiry) : NaN;
      if (Number.isFinite(ms) && ms <= Date.now()) {
        state = 'invoice_expired';
        terminal = true;
        detail = 'The Bitrefill invoice has expired. Do NOT fund this order; create a fresh invoice.';
      } else if (!bitrefillExpiry && verdict.state === 'awaiting_deposit') {
        state = 'deadline_unknown';
        detail =
          'The Bitrefill invoice deadline is unknown on this machine, so this order is NOT shown as ' +
          'payable. Re-run pay with the invoice details, or create a fresh invoice.';
      }
    }
  }

  return {
    provider,
    rozoPaymentId: id,
    rozoPaymentIdSource: idSource,
    // Without the authoritative payment object we are reading a partial view.
    authoritativeView: Boolean(payment),
    linkId: linkId || status?.pl_id || null,
    state,
    unknown: verdict.unknown,
    moneyDetected: verdict.moneyDetected,
    terminal,
    escalate: verdict.escalate,
    detail,
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
      if (provider === 'bitrefill' && !bitrefillExpiry) {
        return { expiresAt: null, expiresIn: null, msRemaining: null, deadlineUnknown: true };
      }
      const iso =
        provider === 'bitrefill'
          ? bitrefillExpiry
          : (payment?.expiresAt ?? status?.rozoPayment?.expiresAt ?? null);
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

/**
 * The human guidance attached to a status result.
 *
 * A Coinbase order id is the Coinbase link id, and the router never frees an
 * order id once used (an expired order still holds it), so an expired
 * Coinbase order means the LINK is spent: re-running pay on it returns
 * LINK_USED_OR_EXPIRED. Never advise a fresh order on the same link.
 */
export function statusGuidance(result) {
  if (result.escalate) {
    return (
      'MONEY DETECTED and the order is not on a healthy path. Do NOT pay again and do NOT create ' +
      'a new order for this link. Preserve linkId, rozoPaymentId and every tx hash, then escalate ' +
      'to the operator for manual reconciliation.'
    );
  }
  if (result.unknown) {
    return (
      'The order state could not be established. This is NOT evidence that nothing was paid — ' +
      'do not create a new order and do not send again on the strength of it. Retry, or pass ' +
      '--rozo-payment-id so the authoritative pay-in view can be read.'
    );
  }
  if (!result.authoritativeView) {
    return (
      'Only the fulfilment view was readable; the pay-in view is unavailable, so the ' +
      'money-detected rule cannot be enforced. Pass --rozo-payment-id for a complete answer.'
    );
  }
  if ((result.state === 'expired_unfunded' || result.state === 'invoice_expired') && result.provider === 'bitrefill') {
    return (
      'Nothing was funded, so nothing was lost. Create a fresh Bitrefill invoice and run ' +
      'rozo-checkout pay --bitrefill-invoice <id> --to <0x…> --amount <USDC> --with <coin>'
    );
  }
  if (result.state === 'expired_unfunded') {
    return (
      'This order expired before any funds arrived. This payment link cannot be paid again: ' +
      're-running pay on it returns LINK_USED_OR_EXPIRED. Get a new payment link from the ' +
      'merchant (OpenRouter) and pay that one. First check your own wallet: if anything was sent ' +
      'to the old deposit address, or a Lightning payment is still pending, do not pay the new ' +
      'link yet; contact support with the linkId and rozoPaymentId.'
    );
  }
  return result.terminal ? 'Done.' : 'Still in flight. Poll again in ~10s.';
}

async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = args['rozo-payment-id'] || (isRozoPaymentId(args._[0]) ? args._[0] : null);
  const linkId = args['link-id'] || (!rozoPaymentId ? args._[0] : null);
  const provider = args.provider ? String(args.provider) : null;
  if (provider && provider !== 'bitrefill' && provider !== 'coinbase') {
    usage('--provider must be coinbase or bitrefill');
  }
  if (provider === 'bitrefill' && !rozoPaymentId) {
    usage('A Bitrefill order is tracked by --rozo-payment-id <uuid>.');
  }
  if (!rozoPaymentId && !linkId) {
    usage('Required: --rozo-payment-id <uuid> and/or --link-id <pl_* | paymentSession_*>');
  }

  const watch = Boolean(args.watch);
  const timeoutMs = Math.max(0, Number(args.timeout ?? 600) * 1000);
  const deadline = Date.now() + timeoutMs;

  let result = await snapshot({ rozoPaymentId, linkId, provider });
  const history = [{ at: new Date().toISOString(), state: result.state }];

  while (watch && !result.terminal && !result.escalate && !result.unknown && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const next = await snapshot({ rozoPaymentId: result.rozoPaymentId || rozoPaymentId, linkId, provider });
    if (next.state !== result.state) history.push({ at: new Date().toISOString(), state: next.state });
    result = next;
  }

  const guidance = statusGuidance(result);

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
      // Anything short of a clean answer gets a human contact.
      ...(failed || unresolved ? { support: SUPPORT } : {}),
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
