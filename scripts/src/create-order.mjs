#!/usr/bin/env node
/**
 * create-order.js — steps 4-6 of the flow.
 *
 *   node scripts/dist/create-order.js --url "<coinbase link>" --chain 900 --token USDT
 *   node scripts/dist/create-order.js --url "<coinbase link>" --chain 900 --token USDT --confirm
 *
 * TWO-PHASE BY DESIGN (PLAN §3 step 6b). Without `--confirm` the full deposit
 * address, memo and BOLT11 are WITHHELD: the caller gets the masked summary
 * needed to ask the user for a binding yes, and nothing that could be paid by
 * accident. Re-running with `--confirm` (which reuses the same order) releases
 * the full `deposit` block and writes a confirmation record. That record is
 * what the send scripts require, and it is bound to a digest of the exact
 * deposit instructions that were shown, so it cannot authorise anything else.
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
  STELLAR_MEMO_TYPE,
} from './lib/amounts.mjs';
import { checkExpiry, formatRemaining } from './lib/expiry.mjs';
import {
  reuseGuard,
  verifyCreateAgainstQuote,
  checkPayable,
  normalizeMerchant,
} from './lib/guards.mjs';
import { assertNotBlacklisted, loadBlacklist } from './lib/blacklist.mjs';
import { createOrderRecord, recordConfirmation } from './lib/state.mjs';

function confirmTier(usdAmount) {
  const usd = Number(usdAmount);
  if (!Number.isFinite(usd)) return 'explicit';
  if (usd <= 1) return 'silent';
  if (usd <= 10) return 'one-line';
  return 'explicit';
}

async function main(argv) {
  const args = parseArgs(argv);
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
  const confirmed = Boolean(args.confirm);

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
    // Special-case the common, benign version of this: an unpaid order already
    // exists for this link and was created for a DIFFERENT coin. The router
    // returns that existing order rather than making a second one, so this is
    // "you already have an order, for another coin" — not a backend fault, and
    // nothing extra was created.
    const onlySourceDrift =
      verify.drift.length > 0 && verify.drift.every((d) => d.field.startsWith('source.'));
    if (created.reused && onlySourceDrift) {
      const existing = created.source || {};
      const remainingMs = created.expiresAt ? Date.parse(created.expiresAt) - Date.now() : NaN;
      emit(
        {
          success: false,
          step: 'reuse-source-mismatch',
          error: {
            code: 'REUSED_SOURCE_MISMATCH',
            message:
              `This link already has an unpaid order, created for ` +
              `${existing.tokenSymbol ?? '?'} on chain ${existing.chainId ?? '?'}. You asked for ` +
              `${tokenSymbol} on chain ${chainId}. Only one order exists per link at a time, so ` +
              `nothing new was created.`,
          },
          linkId: created.linkId ?? parsedLinkId,
          rozoPaymentId,
          paymentLink: created.paymentLink ?? null,
          existingOrder: {
            rozoPaymentId,
            chainId: existing.chainId ?? null,
            tokenSymbol: existing.tokenSymbol ?? null,
            expiresAt: created.expiresAt ?? null,
            expiresIn: Number.isFinite(remainingMs) ? formatRemaining(remainingMs) : null,
          },
          guidance:
            `Either pay the existing order with ${existing.tokenSymbol ?? 'its own coin'} ` +
            `(re-run with --chain ${existing.chainId} --token ${existing.tokenSymbol}), or wait ` +
            `${Number.isFinite(remainingMs) ? formatRemaining(remainingMs) : 'for it to expire'} ` +
            `for it to expire and then create a new one. Unpaid orders cost nothing.`,
        },
        EXIT_ERROR,
      );
    }

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
  const family = chainFamily(source.chainId);
  const tier = confirmTier(usd);

  // `guard.deposit` was produced by validateDepositInstructions: the amount is
  // parsable and positive, Lightning has a BOLT11, Stellar has its memo.
  const depositInfo = guard.deposit;

  if (confirmed) {
    recordConfirmation(rozoPaymentId, { source, invoiceAmount: usd, tier });
  }

  const memoRequirement = lightning
    ? 'Lightning invoices carry their own routing data; there is no separate memo.'
    : source.receiverMemo
      ? 'This deposit REQUIRES the memo/tag below. Sending without it will very likely lose the funds.'
      : family === 'stellar'
        ? 'A Stellar deposit always requires a memo.'
        : 'This deposit does not use a memo. Leave the memo field empty.';

  emit({
    success: true,
    step: 'create-order',
    confirmed,
    reused: Boolean(created.reused),
    reusedNote: created.reused
      ? `An existing unpaid order for this link was reused (${rozoPaymentId}), valid for another ` +
        `${formatRemaining(expiry.msRemaining)}. Nothing new was created.`
      : null,
    orderCost:
      'Creating an order moves no money. An order you never fund simply expires and costs nothing.',
    linkId: created.linkId ?? parsedLinkId,
    rozoPaymentId,
    paymentLink: created.paymentLink ?? null,
    merchant: normalizeMerchant(created.merchant ?? snapshot.merchant),
    invoice: { amount: usd, currency: snapshot?.fiat?.currency ?? 'USD' },
    callerPays: created.callerPays ?? snapshot.callerPays,
    discount: created.discount ?? '0',

    // Machine-readable, copy-pastable — and WITHHELD until --confirm. This is
    // the only place the full address, memo and BOLT11 ever appear.
    deposit: confirmed
      ? {
          chainId: source.chainId,
          chain: chainName(source.chainId),
          tokenSymbol: source.tokenSymbol,
          tokenAddress: source.tokenAddress || null,
          // Lightning has no deposit address: the BOLT11 IS the instruction.
          receiverAddress: lightning ? null : source.receiverAddress,
          receiverMemo: source.receiverMemo ?? null,
          // Stellar memos are TEXT even when they look numeric. Sending one as
          // MEMO_ID produces a different memo and the payment will not match.
          receiverMemoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
          amount: source.amount,
          amountUnit: source.amountUnit ?? null,
          isSats: isSatsUnit(source.amountUnit),
          lnInvoice: bolt11 || null,
          payTo: depositInfo.payTo,
          expiresAt: payment?.expiresAt ?? null,
          expiresIn: formatRemaining(expiry.msRemaining),
        }
      : null,
    depositWithheld: !confirmed,

    // Safe for prose / chat.
    display: {
      chain: chainName(source.chainId),
      token: source.tokenSymbol,
      amount: formatAmount(source),
      isSats: isSatsUnit(source.amountUnit),
      payToMasked: maskAddress(depositInfo.payTo),
      receiverMemoMasked: maskMemo(source.receiverMemo),
      hasMemo: Boolean(source.receiverMemo),
      memoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
      memoRequirement,
    },

    expiry: {
      intentExpiresAt: payment?.expiresAt ?? null,
      coinbaseExpiry: snapshot?.coinbase?.preApprovalExpiry ?? null,
      effectiveDeadlineIso: new Date(expiry.effectiveDeadlineMs).toISOString(),
      // A duration, not just a timestamp: this is what a payer actually needs.
      expiresIn: formatRemaining(expiry.msRemaining),
      msRemaining: expiry.msRemaining,
      marginMinutes: Math.round(expiry.marginMs / 60000),
      minutesOfSlack: Math.floor(expiry.msOfSlack / 60000),
    },

    confirmation: {
      required: tier,
      satisfied: confirmed,
      note: confirmed
        ? 'Confirmation recorded. The send scripts will verify it against the live deposit data.'
        : 'BINDING CONFIRMATION POINT. Present chain, token, exact amount, the masked address, ' +
          'the memo requirement, both expiries and the reused flag, and get an explicit yes. ' +
          'Then re-run this command with --confirm to release the full deposit details.',
      warnings: [
        'Wrong token, wrong network, or wrong amount is usually unrecoverable.',
        memoRequirement,
        'Send exactly once. A second send to the same one-time address is not guaranteed to be credited.',
        'The deposit amount can exceed the invoice: it includes the bridge and network fees.',
      ],
    },

    blacklist: {
      checked: true,
      addressesInList: blacklist.entries.length,
      digest: blacklist.provenance.addressesSha256,
    },

    nextStep: confirmed
      ? {
          modeA: 'Give the user the `deposit` block, then poll: status.js --rozo-payment-id <id>',
          modeB:
            family === 'evm'
              ? `send-evm.js --rozo-payment-id ${rozoPaymentId} --send  (requires ROZO_CHECKOUT_EVM_KEY)`
              : family === 'solana'
                ? `send-sol.js --rozo-payment-id ${rozoPaymentId} --send  (requires ROZO_CHECKOUT_SOL_KEY)`
                : 'not available for this chain — pay from a wallet (Mode A)',
        }
      : {
          confirm: 'Re-run this exact command with --confirm once the user has said yes.',
        },
  });
}

/**
 * Entry point for both the standalone script and the CLI. The standalone
 * bundle (scripts/bin) calls this and lets emit() exit; the CLI calls it
 * inside capture() and gets the payload back. Same flow, same checks.
 */
export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
