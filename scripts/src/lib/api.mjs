/**
 * Backend contract (PLAN §2). Field names here are the literal keys the
 * services return — do not "tidy" them.
 *
 *   quote   POST  {MPP}/quote-invoice          keyless
 *   create  POST  {MPP}/create-invoice         keyless (IP rate-gated)
 *   status  GET   {MPP}/invoice-status         keyless
 *   deposit GET   {INTENTS}/payments/<uuid>    keyless, read-only, authoritative
 *
 * Hard rule: the skill NEVER writes to payment-api directly. Creation always
 * goes through mpprouter (it validates the Coinbase link and seeds fulfillment
 * context). Only the public read-only GET is called against payment-api.
 */

import { createRequire } from 'node:module';

import { getJson, postJson } from './http.mjs';
import { SkillError } from './output.mjs';

// Same resolution the `--version` command uses. Falls back rather than throwing:
// a missing package.json must not stop a payment.
const PKG_VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../../../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

export const MPP_BASE =
  process.env.ROZO_CHECKOUT_MPP_BASE ||
  'https://apiserver.mpprouter.dev/v1/services/rozo-agent-api';

/**
 * Caller provenance sent with every order this CLI creates. The router stores it
 * as `metadata.client`, which is the only way to tell a scripted payment apart
 * from one a human made in the browser — both hit the same create-invoice
 * endpoint, so without this label every order looks identical server-side.
 * Reporting only; it carries no identity and grants no privilege.
 */
export const CLIENT_LABEL = `rozo-checkout-cli/${PKG_VERSION}`;

export const INTENTS_BASE =
  process.env.ROZO_CHECKOUT_INTENTS_BASE ||
  'https://intentapiv4.rozo.ai/functions/v1/payment-api';

/**
 * Step 1-2. Returns the upstream quote spread + `quoteReceipt`.
 * NOTE: quoteReceipt TTL is 60 seconds — create-invoice must follow promptly.
 */
export async function quoteInvoice({ url, linkId }) {
  const body = url ? { url } : { payment_id: linkId };
  return postJson(`${MPP_BASE}/quote-invoice`, body);
}

/** Step 4. Creates (or reuses) the Rozo intent for this Coinbase link. */
export async function createInvoice({ url, linkId, source, quoteReceipt }) {
  const body = {
    ...(url ? { url } : { payment_id: linkId }),
    source: { chainId: String(source.chainId), tokenSymbol: source.tokenSymbol },
    ...(quoteReceipt ? { quoteReceipt } : {}),
    client: CLIENT_LABEL,
  };
  return postJson(`${MPP_BASE}/create-invoice`, body);
}

/** Step 7 / payability revalidation. `payment_id` takes the Coinbase linkId. */
export async function invoiceStatus({ linkId, rozoPaymentId }) {
  const qs = new URLSearchParams();
  if (linkId) qs.set('payment_id', linkId);
  if (rozoPaymentId) qs.set('rozo_payment_id', rozoPaymentId);
  if (![...qs.keys()].length) {
    throw new SkillError('USAGE', 'invoiceStatus needs linkId or rozoPaymentId.');
  }
  return getJson(`${MPP_BASE}/invoice-status?${qs.toString()}`);
}

/**
 * Step 6. Authoritative deposit instructions + pay-in truth.
 * Returns a BARE payment object (no {data} envelope).
 */
export async function getPayment(rozoPaymentId) {
  return getJson(`${INTENTS_BASE}/payments/${encodeURIComponent(rozoPaymentId)}`);
}

/**
 * Normalize the parts of a quote response the skill binds against, so the
 * post-create comparator has a stable snapshot shape.
 */
export function snapshotFromQuote(quote) {
  const cb = quote?.coinbasePayment || quote?.paymentLink || null;
  return {
    linkId: quote?.linkId ?? quote?.paymentId ?? null,
    protocolVersion: quote?.protocolVersion ?? null,
    merchant: quote?.merchant ?? null,
    original: quote?.invoice?.amount ?? null,
    callerPays: quote?.quote?.callerPays ?? null,
    fiat: quote?.invoice?.fiat ?? null,
    coinbase: cb
      ? {
          id: cb.id ?? null,
          status: cb.status ?? null,
          usageCount: cb.usageCount ?? null,
          maxUsage: cb.maxUsage ?? null,
          preApprovalExpiry: cb.preApprovalExpiry ?? cb.expiresAt ?? null,
        }
      : null,
  };
}
