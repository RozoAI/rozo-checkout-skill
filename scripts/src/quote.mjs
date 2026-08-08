#!/usr/bin/env node
/**
 * quote.js — steps 1-2 of the flow. READ-ONLY: creates nothing, moves nothing.
 *
 *   node scripts/dist/quote.js --url "https://payments.coinbase.com/payment-links/pl_..."
 *   node scripts/dist/quote.js --url "<url>" --chain 900 --token USDT
 *
 * Prints one JSON object. Exit 0 on a payable quote, 1 on refusal, 2 on usage.
 *
 * The returned `quoteReceipt` is short-lived (about 60 seconds). Do not stash
 * it for later — create-order.js takes its own fresh quote.
 */

import { parseArgs, emit, fail, usage, EXIT_ERROR, SkillError } from './lib/output.mjs';
import { extractLinkId } from './lib/ids.mjs';
import { quoteInvoice, snapshotFromQuote } from './lib/api.mjs';
import { SUPPORTED_SOURCES, isSupportedSource, chainName } from './lib/amounts.mjs';
import { parseDeadline } from './lib/expiry.mjs';
import { normalizeDecimal } from './lib/guards.mjs';

function derivePayable(snapshot, now) {
  const cb = snapshot.coinbase;
  if (!cb) {
    return { payable: false, code: 'LINK_NO_LONGER_PAYABLE', reason: 'No Coinbase state in the quote.' };
  }
  if (snapshot.protocolVersion === 'v3' && cb.status && cb.status !== 'PAYMENT_SESSION_STATUS_CREATED') {
    return {
      payable: false,
      code: 'LINK_NO_LONGER_PAYABLE',
      reason: `Payment Session status is ${cb.status}; only PAYMENT_SESSION_STATUS_CREATED is payable.`,
    };
  }
  if (cb.usageCount !== null && cb.usageCount !== undefined) {
    const max = cb.maxUsage ?? 1;
    if (Number(cb.usageCount) >= Number(max)) {
      return {
        payable: false,
        code: 'LINK_NO_LONGER_PAYABLE',
        reason: `This payment link has already been used (${cb.usageCount}/${max}).`,
      };
    }
  }
  const exp = parseDeadline(cb.preApprovalExpiry);
  if (exp === null) {
    return {
      payable: false,
      code: 'EXPIRY_UNPARSABLE',
      reason: 'The Coinbase expiry is missing or unparsable; refusing to treat it as payable.',
    };
  }
  if (exp <= now) {
    return {
      payable: false,
      code: 'LINK_NO_LONGER_PAYABLE',
      reason: `This payment link expired at ${new Date(exp).toISOString()}. Ask for a fresh one.`,
    };
  }
  return { payable: true, code: null, reason: null, expiryMs: exp };
}

async function main(argv) {
  const args = parseArgs(argv);
  const url = args.url || args._[0];
  if (!url || url === true) {
    usage('Required: --url "<coinbase payment link or paymentSession url/id>"');
  }

  const { linkId, kind } = extractLinkId(String(url));

  // Optional source choice: validated locally so the caller gets a clean list
  // instead of a server error. Lightning is included here on purpose — it is
  // supported but lives outside the server's SUPPORTED_SOURCE payload.
  let chosenSource = null;
  if (args.chain || args.token) {
    const chainId = String(args.chain ?? '').trim();
    const tokenSymbol = String(args.token ?? '').trim().toUpperCase();
    if (!chainId || !tokenSymbol) {
      usage('--chain and --token must be given together, e.g. --chain 900 --token USDT');
    }
    if (!isSupportedSource(chainId, tokenSymbol)) {
      throw new SkillError(
        'UNSUPPORTED_SOURCE',
        `${tokenSymbol} on ${chainName(chainId)} is not a supported source.`,
        { supported: SUPPORTED_SOURCES },
      );
    }
    chosenSource = { chainId, tokenSymbol };
  }

  const now = Date.now();
  const quote = await quoteInvoice({ url: String(url) });
  const snapshot = snapshotFromQuote(quote);
  const payability = derivePayable(snapshot, now);

  const payload = {
    success: payability.payable,
    step: 'quote',
    linkId: snapshot.linkId ?? linkId,
    linkKind: kind,
    protocolVersion: snapshot.protocolVersion,
    merchant: snapshot.merchant,
    invoice: {
      amount: snapshot.original,
      fiat: snapshot.fiat,
    },
    // No discount on this line: the caller pays the full invoice amount.
    callerPays: snapshot.callerPays,
    discountPolicy: 'none — callerPays equals the invoice amount',
    coinbase: snapshot.coinbase,
    coinbaseExpiryIso: payability.expiryMs ? new Date(payability.expiryMs).toISOString() : null,
    chosenSource,
    supportedSources: SUPPORTED_SOURCES,
    quoteReceipt: quote?.quoteReceipt ?? null,
    quoteReceiptTtlSeconds: 60,
    quoteReceiptNote:
      'Short-lived (~60s). create-order.js takes its own fresh quote; do not carry this over.',
    snapshot,
    nextStep: payability.payable
      ? 'create-order.js --url <url> --chain <chainId> --token <SYMBOL>'
      : null,
  };

  if (!payability.payable) {
    payload.error = { code: payability.code, message: payability.reason };
    emit(payload, EXIT_ERROR);
  }

  // Compare as money, not as text: "5.00" and "5.000000" are the same amount.
  if (
    snapshot.callerPays &&
    snapshot.original &&
    normalizeDecimal(snapshot.callerPays) !== normalizeDecimal(snapshot.original)
  ) {
    payload.warnings = [
      `callerPays (${snapshot.callerPays}) differs from the invoice amount (${snapshot.original}). ` +
        'This flow is supposed to charge the full invoice — do not proceed until that is explained.',
    ];
  }

  emit(payload);
}

/**
 * Entry point for both the standalone script and the CLI. The standalone
 * bundle (scripts/bin) calls this and lets emit() exit; the CLI calls it
 * inside capture() and gets the payload back. Same flow, same checks.
 */
export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
