/**
 * create-bitrefill-order — the Bitrefill twin of create-order.
 *
 *   --invoice-id <id> --to 0x… --amount 7.90 [--expires-at ISO]
 *   --chain <chainId> --token <SYMBOL> [--confirm]
 *
 * Same two-phase contract as create-order: without --confirm the full deposit
 * address is withheld; with it, the deposit block is released and a
 * digest-bound confirmation is recorded for the send scripts.
 *
 * Steps, aborting on the first failure:
 *   1. local validation of the invoice facts (id, address, amount, expiry)
 *   2. blacklist check on the Bitrefill receiving address    -> BLACKLIST_HIT
 *   3. create through mpprouter (never payment-api directly); a 409
 *      DUPLICATE_INVOICE resumes the existing order
 *   4. the router must echo invoiceId/address/amount         -> BITREFILL_ECHO_MISMATCH
 *   5. live GET payments/<id>: the order must pay this invoice (direct model:
 *      the invoice address; funder model: the Rozo funder, with the invoice
 *      frozen in metadata.bitrefill), the fee figures must be complete and
 *      consistent (BITREFILL_FEE_MISMATCH), and the reuse guard (unpaid,
 *      nothing received, right source) must pass
 *   6. expiry margins on the invoice expiry, and for a native coin also its
 *      price lock                                             -> INVOICE_EXPIRING / QUOTE_*
 *   7. blacklist check on the deposit address                -> BLACKLIST_HIT
 *   8. persist local state (provider: bitrefill), then print
 *
 * There is no quote step and no Coinbase payability check: the amount is fixed
 * by the invoice. Which coins work is the router's call (it answers
 * UNSUPPORTED_SOURCE); only ZEC is refused here, because the router never
 * accepts it for Bitrefill.
 */

import { parseArgs, emit, usage, EXIT_ERROR, SkillError } from './lib/output.mjs';
import { assertRozoPaymentId, maskAddress, maskMemo } from './lib/ids.mjs';
import { createBitrefillInvoice, getPayment } from './lib/api.mjs';
import {
  SUPPORTED_SOURCES,
  isSupportedSource,
  isNativeSource,
  chainName,
  chainFamily,
  formatAmount,
  isSatsUnit,
  STELLAR_MEMO_TYPE,
} from './lib/amounts.mjs';
import { formatRemaining, priceLockFor } from './lib/expiry.mjs';
import { nativeDepositWarnings } from './lib/native.mjs';
import { isZecSource } from './lib/zec.mjs';
import { reuseGuard } from './lib/guards.mjs';
import { assertNotBlacklisted, loadBlacklist } from './lib/blacklist.mjs';
import { createOrderRecord, recordConfirmation, readState, findByLinkId } from './lib/state.mjs';
import { SUPPORT, contactEmailFromArgs, contactEmailAttached } from './lib/support.mjs';
import {
  PROVIDER_BITREFILL,
  validateBitrefillInput,
  verifyBitrefillCreate,
  verifyBitrefillDestination,
  checkBitrefillPricing,
  bitrefillPricingDrift,
  duplicateInvoicePaymentId,
  explainRouterError,
  checkBitrefillExpiry,
  BITREFILL_MIN_PAY_WINDOW_MS,
  BITREFILL_LATE_PAYMENT_POLICY,
  earliestExpiry,
  intentBitrefillExpiry,
} from './lib/bitrefill.mjs';

/** Local-record key for a Bitrefill invoice (records have no Coinbase link). */
export const bitrefillRecordKey = (invoiceId) => `bitrefill:${invoiceId}`;

function confirmTier(usdAmount) {
  const usd = Number(usdAmount);
  if (!Number.isFinite(usd)) return 'explicit';
  if (usd <= 1) return 'silent';
  if (usd <= 10) return 'one-line';
  return 'explicit';
}

function abort(step, code, message, extra = {}, guidance = 'Do NOT fund this order.') {
  emit(
    { success: false, step, provider: PROVIDER_BITREFILL, error: { code, message, ...(extra.details ? { details: extra.details } : {}) }, ...extra.fields, guidance },
    EXIT_ERROR,
  );
}

async function main(argv) {
  const args = parseArgs(argv);
  const chainId = String(args.chain ?? '').trim();
  const tokenSymbol = String(args.token ?? '').trim().toUpperCase();
  if (!chainId || !tokenSymbol) usage('Required: --chain <chainId> --token <SYMBOL>.');
  if (!isSupportedSource(chainId, tokenSymbol)) {
    throw new SkillError('UNSUPPORTED_SOURCE', `${tokenSymbol} on ${chainName(chainId)} is not a supported source.`, {
      supported: SUPPORTED_SOURCES,
    });
  }
  // The router never accepts ZEC for Bitrefill (its window outlives a 60
  // minute invoice). Every other coin is the router's call.
  if (isZecSource(chainId, tokenSymbol)) {
    throw new SkillError('ZEC_NOT_AVAILABLE', 'ZEC is not available for Bitrefill invoices. Choose another coin.');
  }
  const native = isNativeSource(chainId, tokenSymbol);
  const requested = { chainId, tokenSymbol };
  const confirmed = Boolean(args.confirm);
  // Optional; validated before any network call so a typo creates nothing.
  const email = contactEmailFromArgs(args);

  // --- 1. local validation -----------------------------------------------
  // Showing a deposit needs BITREFILL_MIN_PAY_WINDOW_MS; creating a NEW
  // order needs the stricter BITREFILL_MIN_EXPIRY_MS (checked below once we
  // know whether this machine already created one for this invoice).
  const rawInvoice = {
    invoiceId: args['invoice-id'],
    address: args.to,
    amount: args.amount,
    expiresAt: args['expires-at'],
  };
  const invoice = validateBitrefillInput(rawInvoice, Date.now(), BITREFILL_MIN_PAY_WINDOW_MS);
  const priorRecord = findByLinkId(bitrefillRecordKey(invoice.invoiceId));
  if (!priorRecord) validateBitrefillInput(rawInvoice);

  // --- 2. blacklist: fail closed, and check the destination first --------
  let blacklist;
  try {
    blacklist = loadBlacklist();
  } catch (err) {
    throw new SkillError('BLACKLIST_UNAVAILABLE', `Compromised-address list unusable: ${err.message} Refusing to proceed.`);
  }
  assertNotBlacklisted([{ address: invoice.address, family: 'evm', role: 'Bitrefill receiving address' }], blacklist);

  // --- 3. create through the router --------------------------------------
  let created = null;
  let rozoPaymentId;
  let resumed = false;
  let routerPricing = null;
  try {
    created = await createBitrefillInvoice({
      invoice,
      source: requested,
      utmSource: typeof args['utm-source'] === 'string' ? args['utm-source'] : undefined,
      email,
    });
  } catch (err) {
    const existing = duplicateInvoicePaymentId(err);
    if (!existing) throw explainRouterError(err);
    rozoPaymentId = assertRozoPaymentId(existing);
    resumed = true;
    routerPricing = err?.details?.body && typeof err.details.body === 'object' ? err.details.body : {};
  }

  // --- 4. the router must echo the invoice -------------------------------
  if (created) {
    if (created.ok === false || !created.rozoPaymentId) {
      throw new SkillError(created?.error || 'CREATE_FAILED', created?.message || 'create-invoice returned no rozoPaymentId.');
    }
    rozoPaymentId = assertRozoPaymentId(created.rozoPaymentId);
    routerPricing = created;
    const echo = verifyBitrefillCreate({ requested: invoice, created });
    if (!echo.ok) {
      abort('verify-create', echo.code, echo.reason, {
        details: { drift: echo.drift },
        fields: { rozoPaymentId, invoiceId: invoice.invoiceId },
      }, 'The order exists but was NOT validated. Do not fund it. Let it expire unfunded.');
    }
  }

  // A resumed order must also match what this machine recorded for it.
  const local = readState(rozoPaymentId);
  if (local?.bitrefill) {
    const prior = verifyBitrefillCreate({
      requested: invoice,
      created: { provider: PROVIDER_BITREFILL, invoiceId: local.bitrefill.invoiceId, destination: { chainId: '8453', tokenSymbol: 'USDC', address: local.bitrefill.address, amount: local.bitrefill.amount } },
    });
    if (!prior.ok) {
      abort('verify-local', prior.code, 'This invoice id was recorded earlier with a different address or amount.', {
        details: { drift: prior.drift },
        fields: { rozoPaymentId, invoiceId: invoice.invoiceId },
      });
    }
  }

  // --- 5. authoritative intent -------------------------------------------
  const payment = await getPayment(rozoPaymentId);
  const source = payment?.source || {};
  const dest = verifyBitrefillDestination({ requested: invoice, payment });
  if (!dest.ok) {
    abort('verify-destination', dest.code, dest.reason, {
      details: { drift: dest.drift },
      fields: { rozoPaymentId, invoiceId: invoice.invoiceId },
    });
  }

  // Service fee: the router's fee fields (Coinbase line names), checked with
  // the Coinbase line's pricing guard, must match what the live order charges.
  const fee = checkBitrefillPricing({ invoiceAmount: invoice.amount, routerPricing, live: dest, source });
  if (!fee.ok) {
    abort('fee-guard', fee.code, fee.reason, {
      details: fee.details,
      fields: { rozoPaymentId, invoiceId: invoice.invoiceId },
    }, 'Do not fund this order. Let it expire unfunded.');
  }
  const pricing = fee.pricing;
  // A resumed order must still charge what this machine recorded for it. A
  // record without pricing predates the fee and only ever confirmed zero.
  if (local?.bitrefill) {
    const drift = bitrefillPricingDrift(local.bitrefill.pricing, pricing);
    if (drift.length) {
      abort('fee-guard', 'BITREFILL_FEE_MISMATCH', 'The live order charges a different fee than the one recorded for it earlier.', {
        details: { drift },
        fields: { rozoPaymentId, invoiceId: invoice.invoiceId },
      }, 'Do not fund this order. Let it expire unfunded.');
    }
  }

  const guard = reuseGuard({ payment, requested, reused: resumed });
  if (!guard.ok) {
    emit(
      {
        success: false,
        step: 'reuse-guard',
        provider: PROVIDER_BITREFILL,
        error: { code: guard.code, message: guard.reason, details: guard.evidence },
        invoiceId: invoice.invoiceId,
        rozoPaymentId,
        moneyDetected: guard.moneyDetected,
        guidance: guard.moneyDetected
          ? 'MONEY DETECTED. Do not pay again. Preserve every id and tx hash above and escalate for manual reconciliation.'
          : 'Abort this run. Nothing was funded.',
      },
      EXIT_ERROR,
    );
  }

  // --- 6. expiry ------------------------------------------------------------
  // Expiry comes from the Bitrefill invoice only, never from the intent's own
  // expiresAt. A resume can never extend it: take the earliest of what this
  // machine recorded, what the intent recorded, and what was just supplied.
  const invoiceExpiry = earliestExpiry(
    invoice.expiresAt,
    local?.bitrefill?.expiresAt,
    priorRecord?.bitrefill?.expiresAt,
    intentBitrefillExpiry(payment),
  );
  const lightning = String(source.chainId) === 'lightning';
  // Native coins: the price lock too (live, create response, local record;
  // the earliest wins, none at all is a refusal).
  const quoteExpiresAt = priceLockFor({
    native,
    payment,
    others: [created?.quoteExpiresAt, local?.quoteExpiresAt, local?.confirmation?.quoteExpiresAt],
  });
  const expiry = checkBitrefillExpiry(invoiceExpiry, Date.now(), BITREFILL_MIN_PAY_WINDOW_MS, native ? { quoteExpiresAt, chainId: source.chainId } : {});
  if (!expiry.ok) {
    abort('expiry-guard', expiry.code, expiry.reason, {
      details: expiry,
      fields: { rozoPaymentId, invoiceId: invoice.invoiceId },
    }, 'Not enough time remains to fund and settle safely. Create a fresh Bitrefill invoice. Do not fund this order.');
  }

  // --- 7. blacklist on the deposit address -------------------------------
  try {
    assertNotBlacklisted([{ address: source.receiverAddress, family: chainFamily(source.chainId), role: 'deposit address' }], blacklist);
  } catch (err) {
    abort('blacklist', err.code, err.message, { fields: { rozoPaymentId } }, 'Do NOT send anything. Report this to the operator immediately.');
  }

  // --- 8. persist, then print ---------------------------------------------
  const bitrefill = {
    ...invoice,
    expiresAt: invoiceExpiry,
    // What the user confirms; the send scripts refuse if the live order drifts.
    pricing: { model: pricing.model, serviceFee: pricing.serviceFee, feeBps: pricing.feeBps, callerPays: pricing.callerPays },
  };
  createOrderRecord({
    rozoPaymentId,
    provider: PROVIDER_BITREFILL,
    bitrefill,
    linkId: bitrefillRecordKey(invoice.invoiceId),
    merchant: 'Bitrefill',
    invoiceAmount: invoice.amount,
    source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    receiverAddress: source.receiverAddress,
    receiverMemo: source.receiverMemo ?? null,
    amount: source.amount,
    amountUnit: source.amountUnit ?? null,
    expiresAt: payment?.expiresAt ?? null,
    ...(native ? { quoteExpiresAt } : {}),
  });

  // The confirmation tier follows what the user pays, fee included.
  const tier = confirmTier(pricing.callerPays);
  if (confirmed) {
    recordConfirmation(rozoPaymentId, {
      source,
      invoiceAmount: invoice.amount,
      tier,
      ...(native ? { quoteExpiresAt } : {}),
    });
  }

  const family = chainFamily(source.chainId);
  const depositInfo = guard.deposit;
  const bolt11 = source.lnInvoice ?? payment?.lnInvoice ?? null;
  const memoRequirement = lightning
    ? 'Lightning invoices carry their own routing data; there is no separate memo.'
    : source.receiverMemo
      ? 'This deposit REQUIRES the memo/tag below. Sending without it will very likely lose the funds.'
      : 'This deposit does not use a memo. Leave the memo field empty.';

  emit({
    success: true,
    step: 'create-order',
    provider: PROVIDER_BITREFILL,
    confirmed,
    // False on a resumed order: the router does not attach an email to it.
    contactEmailProvided: contactEmailAttached(email, resumed),
    support: SUPPORT,
    reused: resumed,
    reusedNote: resumed ? `An order for this Bitrefill invoice already existed (${rozoPaymentId}); it was resumed. Nothing new was created.` : null,
    orderCost: 'Creating an order moves no money. An order you never fund simply expires and costs nothing.',
    invoiceId: invoice.invoiceId,
    rozoPaymentId,
    merchant: 'Bitrefill',
    invoice: { amount: invoice.amount, currency: 'USDC' },
    // Same names as the OpenRouter line: original = Bitrefill receives,
    // serviceFee = Rozo's fee (feeBps of the invoice, rounded up to the cent),
    // callerPays = both. pricing adds the router model and, for stablecoin
    // deposits, bridgeFee = the rest of the deposit.
    original: pricing.original,
    serviceFee: pricing.serviceFee,
    feeBps: pricing.feeBps,
    callerPays: pricing.callerPays,
    discount: '0',
    pricing,
    latePaymentPolicy: BITREFILL_LATE_PAYMENT_POLICY,
    bitrefill: {
      invoiceId: invoice.invoiceId,
      addressMasked: maskAddress(invoice.address),
      amount: invoice.amount,
      chain: 'Base',
      token: 'USDC',
      expiresAt: bitrefill.expiresAt,
      destinationAddressVerifiedOnIntent: dest.addressVerified,
    },
    deposit: confirmed
      ? {
          chainId: source.chainId,
          chain: chainName(source.chainId),
          tokenSymbol: source.tokenSymbol,
          tokenAddress: source.tokenAddress || null,
          receiverAddress: lightning ? null : source.receiverAddress,
          receiverMemo: source.receiverMemo ?? null,
          receiverMemoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
          amount: source.amount,
          amountUnit: source.amountUnit ?? null,
          isSats: isSatsUnit(source.amountUnit),
          lnInvoice: bolt11 || null,
          payTo: depositInfo.payTo,
          expiresAt: payment?.expiresAt ?? null,
          expiresIn: formatRemaining(expiry.msRemaining),
          native,
          exactOut: native || lightning,
          quoteExpiresAt: native ? quoteExpiresAt : null,
        }
      : null,
    depositWithheld: !confirmed,
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
      native,
      priceLockedUntil: native ? quoteExpiresAt : null,
      // The bare decimal amount (not secret), for balance comparisons.
      coinAmount: isSatsUnit(source.amountUnit) ? null : String(source.amount ?? ''),
    },
    expiry: {
      intentExpiresAt: payment?.expiresAt ?? null,
      invoiceExpiresAt: bitrefill.expiresAt,
      quoteExpiresAt: native ? quoteExpiresAt : null,
      effectiveDeadlineIso: new Date(expiry.effectiveDeadlineMs).toISOString(),
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
        : 'BINDING CONFIRMATION POINT. Present the Bitrefill invoice id, the USDC amount Bitrefill receives (original), ' +
          'the Rozo service fee (serviceFee, feeBps bps) and the total (callerPays), ' +
          'the coin and exact amount to send (it also covers the bridge and network fees), the masked deposit address, ' +
          'the expiry, and that a payment arriving after the invoice expires is not forwarded to Bitrefill, and get an explicit yes. ' +
          'Then re-run with --confirm to release the full deposit details.',
      warnings: [
        'Wrong token, wrong network, or wrong amount is usually unrecoverable.',
        memoRequirement,
        'Send exactly once. A second send to the same one-time address is not guaranteed to be credited.',
        pricing.feeBps > 0
          ? `You pay the invoice plus a ${pricing.feeBps / 100}% Rozo service fee (${pricing.serviceFee} USDC, total ${pricing.callerPays} USDC), plus the bridge and network fees.`
          : 'The deposit amount can exceed the invoice: it includes the bridge and network fees.',
        BITREFILL_LATE_PAYMENT_POLICY,
        ...(native ? nativeDepositWarnings({ tokenSymbol: source.tokenSymbol, chainId: source.chainId }) : []),
      ],
    },
    blacklist: { checked: true, addressesInList: blacklist.entries.length, digest: blacklist.provenance.addressesSha256 },
    nextStep: confirmed
      ? {
          modeA: 'Give the user the `deposit` block, then poll: rozo-checkout status <rozoPaymentId>',
          modeB: family === 'evm' || family === 'solana' ? 'rozo-checkout pay … --send' : 'not available for this chain — pay from a wallet (Mode A)',
        }
      : { confirm: 'Re-run this exact command with --confirm once the user has said yes.' },
  });
}

export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
