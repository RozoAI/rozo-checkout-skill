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

import { getJson, postJson } from './http.mjs';
import { SkillError } from './output.mjs';
import { normalizeUtmSource } from './utm.mjs';
import { attributionIdentity } from './identity.mjs';
import { PKG_VERSION } from './version.mjs';

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

/**
 * Order-level attribution (router contract of 2026-09-25). The router writes
 * `attribution` to `metadata.attribution` on intent creation, next to the
 * legacy `metadata.client` above, so orders can be split by surface: this
 * skill vs agent.rozo.ai vs checkout.rozo.ai. Same rules as CLIENT_LABEL:
 * reporting only, no identity, and the router drops malformed values instead
 * of failing the order.
 */
export const ATTRIBUTION_CLIENT = `rozo-checkout-skill/${PKG_VERSION}`;

/**
 * The `attribution` object sent on create-invoice. An explicit `utmSource`
 * (the --utm-source flag) wins over ROZO_CHECKOUT_UTM_SOURCE; an invalid or
 * empty value omits the key rather than falling back or failing.
 *
 * It also carries the anonymous `install_id` and, when an OpenRouter
 * identifier is present locally, its salted `account_hash` (identity.mjs).
 * ROZO_CHECKOUT_ANON_ID=off omits both.
 */
export function buildAttribution({ utmSource, identity } = {}) {
  const raw = utmSource !== undefined ? utmSource : process.env.ROZO_CHECKOUT_UTM_SOURCE;
  const utm_source = normalizeUtmSource(raw);
  const ids = identity ?? attributionIdentity();
  return {
    client: ATTRIBUTION_CLIENT,
    ...(utm_source ? { utm_source } : {}),
    ...(ids.install_id ? { install_id: ids.install_id } : {}),
    ...(ids.account_hash ? { account_hash: ids.account_hash } : {}),
  };
}

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

/**
 * A 429 retry resends the same body, quoteReceipt included. The receipt lives
 * 60 seconds, so rate-limit waits on a receipt-carrying create stay well
 * inside that; a longer server wait fails as RATE_LIMITED instead of
 * resubmitting an expired receipt.
 */
export const QUOTE_RECEIPT_RETRY_BUDGET_MS = 20_000;

/** Step 4. Creates (or reuses) the Rozo intent for this Coinbase link. */
export async function createInvoice({ url, linkId, source, quoteReceipt, utmSource, email }) {
  const body = {
    ...(url ? { url } : { payment_id: linkId }),
    source: { chainId: String(source.chainId), tokenSymbol: source.tokenSymbol },
    ...(quoteReceipt ? { quoteReceipt } : {}),
    client: CLIENT_LABEL,
    attribution: buildAttribution({ utmSource }),
    // Optional payer contact email (validated by the caller). Omitted, never
    // sent empty, when the user gave none.
    ...(email ? { email } : {}),
  };
  return postJson(
    `${MPP_BASE}/create-invoice`,
    body,
    quoteReceipt ? { maxTotalWaitMs: QUOTE_RECEIPT_RETRY_BUDGET_MS } : undefined,
  );
}

/**
 * Bitrefill invoice (router contract of 2026-10-01). There is no quote step:
 * the amount is fixed by the invoice, and the router creates an exactOut
 * intent delivering exactly `amount` USDC on Base to `address`. Deposit
 * details then come from getPayment(rozoPaymentId) as usual.
 */
export async function createBitrefillInvoice({ invoice, source, utmSource, email }) {
  const body = {
    provider: 'bitrefill',
    bitrefill: {
      invoiceId: invoice.invoiceId,
      address: invoice.address,
      amount: invoice.amount,
      ...(invoice.expiresAt ? { expiresAt: invoice.expiresAt } : {}),
    },
    source: { chainId: String(source.chainId), tokenSymbol: source.tokenSymbol },
    client: CLIENT_LABEL,
    attribution: buildAttribution({ utmSource }),
    ...(email ? { email } : {}),
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
