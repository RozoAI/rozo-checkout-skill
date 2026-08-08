#!/usr/bin/env node
/**
 * create-order.js — steps 4-6 of the flow.
 *
 *   node scripts/dist/create-order.js --url "<coinbase link>" --chain 900 --token USDT
 *
 * What it does, in order, aborting on the first failure:
 *   1. fresh quote (the receipt lives ~60s, so we never carry one over)
 *   2. create-invoice through the router
 *   3. post-create verification against the quoted snapshot   -> CREATE_DRIFT
 *   4. live GET payments/<rozoPaymentId> (authoritative)
 *   5. reuse guard: unpaid + no txHash + no receipt + no confirmedAt,
 *      and the source must match what was asked for
 *                                     -> ORDER_ALREADY_FUNDED / REUSED_SOURCE_MISMATCH
 *   6. expiry margins on min(intent expiry, Coinbase expiry)  -> EXPIRY_MARGIN
 *   7. blacklist check on the deposit address                 -> BLACKLIST_HIT
 *   8. payability revalidation immediately before exposing the address
 *                                                             -> LINK_NO_LONGER_PAYABLE
 *   9. persist local state, then print the deposit block
 *
 * Creating an order moves no money. It costs nothing if left unfunded.
 * The full deposit address appears ONLY inside the `deposit` object below;
 * everything meant for prose is masked.
 */

import {
  parseArgs,
  emit,
  fail,
  usage,
  EXIT_ERROR,
  SkillError,
} from './lib/output.mjs';
import { extractLinkId, assertRozoPaymentId, maskAddress, maskMemo } from './lib/ids.mjs';
import { quoteInvoice, createInvoice, getPayment, invoiceStatus, snapshotFromQuote } from './lib/api.mjs';
import {
  SUPPORTED_SOURCES,
  isSupportedSource,
  chainName,
  chainFamily,
  formatAmount,
  isSatsUnit,
} from './lib/amounts.mjs';
import { checkExpiry } from './lib/expiry.mjs';
import { reuseGuard, verifyCreateAgainstQuote, checkPayable } from './lib/guards.mjs';
import { assertNotBlacklisted, loadBlacklist } from './lib/blacklist.mjs';
import { createOrderRecord } from './lib/state.mjs';

function confirmTier(usdAmount) {
  const usd = Number(usdAmount);
  if (!Number.isFinite(usd)) return 'explicit';
  if (usd <= 1) return 'silent';
  if (usd <= 10) return 'one-line';
  return 'explicit';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || args._[0];
  if (!url || url === true) usage('Required: --url "<coinbase payment link url or id>"');
  const chainId = String(args.chain ?? '').trim();
  const tokenSymbol = String(args.token ?? '').trim().toUpperCase();
  if (!chainId || !tokenSymbol) {
    usage('Required: --chain <chainId> --token <SYMBOL>. Run quote.js to see supported sources.');
  }
  if (!isSupportedSource(chainId, tokenSymbol)) {
    throw new SkillError(
      'UNSUPPORTED_SOURCE',
      `${tokenSymbol} on ${chainName(chainId)} is not a supported source.`,
      { supported: SUPPORTED_SOURCES },
    );
  }
  const requested = { chainId, tokenSymbol };

  // Fail closed on the blacklist before doing anything else, so a broken
  // vendored list can never be discovered only after an address is on screen.
  let blacklist;
  try {
    blacklist = loadBlacklist();
  } catch (err) {
    throw new SkillError(
      'BLACKLIST_UNAVAILABLE',
      `Compromised-address list unusable: ${err.message} Refusing to proceed.`,
    );
  }

  const { linkId: parsedLinkId } = extractLinkId(String(url));

  // --- 1. fresh quote -----------------------------------------------------
  const quote = await quoteInvoice({ url: String(url) });
  const snapshot = snapshotFromQuote(quote);
  const quoteReceipt = quote?.quoteReceipt ?? null;

  // --- 2. create ----------------------------------------------------------
  const created = await createInvoice({
    url: String(url),
    source: requested,
    quoteReceipt,
  });
  if (!created?.rozoPaymentId) {
    throw new SkillError('CREATE_FAILED', 'create-invoice returned no rozoPaymentId.', {
      response: created,
    });
  }
  const rozoPaymentId = assertRozoPaymentId(created.rozoPaymentId);

  // --- 3. post-create verification ---------------------------------------
  const verify = verifyCreateAgainstQuote({ snapshot, created, requested });
  if (!verify.ok) {
    emit(
      {
        success: false,
        step: 'verify-create',
        error: { code: verify.code, message: verify.reason, details: { drift: verify.drift } },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        paymentLink: created.paymentLink ?? null,
        guidance:
          'The order exists but was NOT validated. Do not fund it. Let it expire unfunded.',
      },
      EXIT_ERROR,
    );
  }

  // --- 4. authoritative deposit detail -----------------------------------
  const payment = await getPayment(rozoPaymentId);
  const source = payment?.source || {};

  // --- 5. reuse guard -----------------------------------------------------
  const guard = reuseGuard({ payment, requested, reused: created.reused });
  if (!guard.ok) {
    emit(
      {
        success: false,
        step: 'reuse-guard',
        error: { code: guard.code, message: guard.reason, details: guard.evidence },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        paymentLink: created.paymentLink ?? null,
        moneyDetected: guard.moneyDetected,
        guidance: guard.moneyDetected
          ? 'MONEY DETECTED. Do not pay again, do not retry into a new order. Preserve every id ' +
            'and tx hash above and escalate to the operator for manual reconciliation.'
          : 'Abort this run. Nothing was funded.',
      },
      EXIT_ERROR,
    );
  }

  // --- 6. expiry margins --------------------------------------------------
  const lightning = String(source.chainId) === 'lightning';
  const bolt11 = source.lnInvoice ?? payment?.lnInvoice ?? null;
  const expiry = checkExpiry({
    now: Date.now(),
    chainId: source.chainId ?? chainId,
    intentExpiresAt: payment?.expiresAt,
    coinbaseExpiry: snapshot?.coinbase?.preApprovalExpiry,
    // For Lightning the BOLT11's own validity is an extra gate. We only have a
    // separate expiry if the backend exposes one; otherwise the intent expiry
    // governs and we still require the 10-minute floor via the margin.
    ...(lightning ? { bolt11ExpiresAt: payment?.expiresAt } : {}),
  });
  if (!expiry.ok) {
    emit(
      {
        success: false,
        step: 'expiry-guard',
        error: { code: expiry.code, message: expiry.reason, details: expiry },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        guidance:
          'Not enough time remains to fund, bridge and settle safely. Ask the merchant for a ' +
          'fresh link and start over. Do not fund this order.',
      },
      EXIT_ERROR,
    );
  }

  // --- 7. blacklist on the destination -----------------------------------
  try {
    assertNotBlacklisted(
      [
        {
          address: source.receiverAddress,
          family: chainFamily(source.chainId),
          role: 'deposit address',
        },
      ],
      blacklist,
    );
  } catch (err) {
    emit(
      {
        success: false,
        step: 'blacklist',
        error: { code: err.code, message: err.message },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        guidance: 'Do NOT send anything. Report this to the operator immediately.',
      },
      EXIT_ERROR,
    );
  }

  // --- 8. payability revalidation, immediately before exposing the address -
  const statusNow = await invoiceStatus({ linkId: created.linkId ?? parsedLinkId });
  const payable = checkPayable(statusNow, Date.now());
  if (!payable.ok) {
    emit(
      {
        success: false,
        step: 'payability-revalidation',
        error: { code: payable.code, message: payable.reason, details: payable.derived },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        guidance:
          'The Coinbase resource stopped being payable between quote and now (someone else may ' +
          'have paid it). Do NOT fund this order.',
      },
      EXIT_ERROR,
    );
  }

  // --- 9. persist state, then print --------------------------------------
  createOrderRecord({
    rozoPaymentId,
    linkId: created.linkId ?? parsedLinkId,
    paymentLink: created.paymentLink ?? null,
    merchant: created.merchant ?? snapshot.merchant,
    invoiceAmount: created.original ?? snapshot.original,
    source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    receiverAddress: source.receiverAddress,
    receiverMemo: source.receiverMemo ?? null,
    amount: source.amount,
    amountUnit: source.amountUnit ?? null,
    expiresAt: payment?.expiresAt ?? null,
  });

  const usd = created.original ?? snapshot.original;

  emit({
    success: true,
    step: 'create-order',
    reused: Boolean(created.reused),
    reusedNote: created.reused
      ? 'An existing unfunded order for this link was reused; it passed the funded-check above.'
      : null,
    linkId: created.linkId ?? parsedLinkId,
    rozoPaymentId,
    paymentLink: created.paymentLink ?? null,
    merchant: created.merchant ?? snapshot.merchant,
    invoice: { amount: usd, currency: snapshot?.fiat?.currency ?? 'USD' },
    callerPays: created.callerPays ?? snapshot.callerPays,
    discount: created.discount ?? '0',

    // Machine-readable, copy-pastable. This is the ONLY place the full address
    // and memo appear.
    deposit: {
      chainId: source.chainId,
      chain: chainName(source.chainId),
      tokenSymbol: source.tokenSymbol,
      tokenAddress: source.tokenAddress ?? null,
      receiverAddress: source.receiverAddress,
      receiverMemo: source.receiverMemo ?? null,
      amount: source.amount,
      amountUnit: source.amountUnit ?? null,
      isSats: isSatsUnit(source.amountUnit),
      lnInvoice: bolt11,
      expiresAt: payment?.expiresAt ?? null,
    },

    // Safe for prose / chat.
    display: {
      chain: chainName(source.chainId),
      token: source.tokenSymbol,
      amount: formatAmount(source),
      receiverAddressMasked: maskAddress(source.receiverAddress),
      receiverMemoMasked: maskMemo(source.receiverMemo),
      hasMemo: Boolean(source.receiverMemo),
    },

    expiry: {
      intentExpiresAt: payment?.expiresAt ?? null,
      coinbaseExpiry: snapshot?.coinbase?.preApprovalExpiry ?? null,
      effectiveDeadlineIso: new Date(expiry.effectiveDeadlineMs).toISOString(),
      marginMinutes: Math.round(expiry.marginMs / 60000),
      minutesOfSlack: Math.floor(expiry.msOfSlack / 60000),
    },

    confirmation: {
      required: confirmTier(usd),
      note:
        'This is the binding confirmation point. Present chain, token, exact amount, masked ' +
        'address, memo presence, both expiries and the reused flag, then ask.',
      warnings: [
        'Wrong token, wrong network, or wrong amount is usually unrecoverable.',
        source.receiverMemo
          ? 'This deposit REQUIRES the memo/tag. Sending without it can lose the funds.'
          : 'No memo is required for this deposit.',
        'Send exactly once. A second send to the same one-time address is not guaranteed to be credited.',
      ],
    },

    blacklist: {
      checked: true,
      addressesInList: blacklist.entries.length,
      digest: blacklist.provenance.addressesSha256,
    },

    nextStep: {
      modeA: 'Pay the deposit from any wallet, then poll: status.js --rozo-payment-id <id>',
      modeB:
        chainFamily(source.chainId) === 'evm'
          ? 'send-evm.js --rozo-payment-id <id>  (requires ROZO_CHECKOUT_EVM_KEY)'
          : chainFamily(source.chainId) === 'solana'
            ? 'send-sol.js --rozo-payment-id <id>  (requires ROZO_CHECKOUT_SOL_KEY)'
            : 'not available for this chain — pay from a wallet (Mode A)',
    },
  });
}

main().catch((err) => fail(err));
