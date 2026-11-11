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
 *   NO_DISCOUNT_VIOLATION    the server reported a non-zero discount
 *   PRICING_VIOLATION        callerPays != original + serviceFee, or the
 *                            service fee is not explicit, over the cap, or
 *                            not the fee its own feeBps produces
 */

import { comparePayment, sourceAtomic, chainFamily, isNativeSource, toAtomic } from './amounts.mjs';
import { isZecSource, zecStatusOf, validateShieldedDeposit, zecMoneySeen } from './zec.mjs';

/** Statuses that mean "nothing has been funded yet". */
export const UNPAID_STATUS = 'payment_unpaid';

/** Intent statuses past the pay-in, on the way to (or at) payout. */
const NATIVE_PROGRESS_STATUSES = new Set([
  'payment_payin_completed',
  'payment_bridging',
  'payment_payout_started',
  'payment_payout_completed',
  'payment_completed',
]);

/**
 * Decide whether a `source` shows a receipt, failing CLOSED.
 *
 * PLAN requires `amountReceived` to be strictly null or zero before an order
 * may be funded. A value we cannot parse ("unknown", "1,5", an object) is NOT
 * evidence of absence — treating it as "no receipt" is how a second payment
 * gets sent. Anything non-null that does not parse to exactly zero counts as
 * money.
 *
 * @returns {{money:boolean, receipt:object|null, unparsable:boolean}}
 */
export function receiptSignal(source) {
  const raw = source?.amountReceived;
  if (raw === null || raw === undefined || raw === '') {
    return { money: false, receipt: null, unparsable: false };
  }
  try {
    const receipt = comparePayment(source);
    return { money: receipt.state !== 'none', receipt, unparsable: false };
  } catch {
    // Non-null but unreadable: assume money until a human says otherwise.
    return { money: true, receipt: null, unparsable: true };
  }
}

/**
 * Deposit instructions must be COMPLETE before anyone is told to pay them
 * (PLAN §3 step 6). Returns a verdict rather than throwing so both Mode A and
 * Mode B can route it into their own output shape.
 *
 * Per-family requirements:
 *   lightning — a BOLT11 string; `receiverAddress` is empty by design
 *   stellar   — an address AND a memo; a Stellar deposit without its memo is
 *               credited to nobody, so a missing memo is a hard abort and must
 *               never be rendered as "no memo required"
 *   others    — an address; a memo if the backend supplied one
 * All families — a parsable, strictly positive amount.
 */
export function validateDepositInstructions(source) {
  const family = chainFamily(source?.chainId);
  const address = typeof source?.receiverAddress === 'string' ? source.receiverAddress.trim() : '';
  const memo = typeof source?.receiverMemo === 'string' ? source.receiverMemo.trim() : '';
  const bolt11 =
    typeof source?.lnInvoice === 'string' && source.lnInvoice.trim() ? source.lnInvoice.trim() : '';

  let amountAtomic;
  try {
    amountAtomic = sourceAtomic(source, 'amount');
  } catch (err) {
    return {
      ok: false,
      code: 'DEPOSIT_INCOMPLETE',
      reason: `The deposit amount is unusable: ${err.message}`,
    };
  }
  if (amountAtomic === null || amountAtomic <= 0n) {
    return {
      ok: false,
      code: 'DEPOSIT_INCOMPLETE',
      reason: 'The order carries no positive deposit amount.',
    };
  }

  if (family === 'lightning') {
    if (!bolt11) {
      return {
        ok: false,
        code: 'DEPOSIT_INCOMPLETE',
        reason:
          'The Lightning order has no BOLT11 invoice yet (the swap may still be being created). ' +
          'Nothing is payable until it appears.',
      };
    }
    return { ok: true, code: null, reason: null, family, amountAtomic, payTo: bolt11, memo: null };
  }

  if (!address) {
    return {
      ok: false,
      code: 'DEPOSIT_NOT_LIVE',
      reason: 'The live payments response returned no deposit address.',
    };
  }

  // Shielded ZEC: the address must be a Unified Address and the ZIP-321
  // payment URI (what the payer scans) must name exactly this address and
  // amount. The URI is shown verbatim, so it is checked, never rebuilt.
  if (family === 'zcash' && zecStatusOf(source)?.receive === 'shielded') {
    const zec = validateShieldedDeposit(source);
    if (!zec.ok) return { ok: false, code: zec.code, reason: zec.reason };
    return { ok: true, code: null, reason: null, family, amountAtomic, payTo: zec.address, memo: null, paymentUri: zec.paymentUri };
  }

  if (family === 'stellar' && !memo) {
    return {
      ok: false,
      code: 'DEPOSIT_MEMO_REQUIRED',
      reason:
        'A Stellar deposit requires a memo, and this order did not supply one. Sending without ' +
        'it would very likely lose the funds. Refusing to display it as payable.',
    };
  }

  return {
    ok: true,
    code: null,
    reason: null,
    family,
    amountAtomic,
    payTo: address,
    memo: memo || null,
  };
}

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
  const signal = receiptSignal(source);
  const hasConfirm =
    source.confirmedAt !== null && source.confirmedAt !== undefined && source.confirmedAt !== '';
  // Zcash custody orders report the pay-in in source.zec first (a mempool
  // sighting, then confirmations), before txHash / amountReceived are filled
  // in. That is money too, and it outranks everything below.
  const zecSeen = isZecSource(source.chainId, source.tokenSymbol) && zecMoneySeen(zecStatusOf(source));
  if (hasTx || signal.money || hasConfirm || zecSeen) {
    return {
      ok: false,
      code: 'ORDER_ALREADY_FUNDED',
      reason: signal.unparsable
        ? 'This order reports an amountReceived that cannot be read. It is treated as funded ' +
          'until a human confirms otherwise — do NOT pay again.'
        : zecSeen && !hasTx && !signal.money && !hasConfirm
          ? 'A shielded ZEC payment to this order has already been seen on the network. Do NOT pay again; ' +
            'watch it with status instead.'
          : 'This Coinbase link already has a funded Rozo order (it may have been paid ' +
            'elsewhere). Do NOT pay again — escalate for manual reconciliation.',
      moneyDetected: true,
      evidence: { ...evidence, receipt: signal.receipt, receiptUnparsable: signal.unparsable, ...(zecSeen ? { zec: zecStatusOf(source) } : {}) },
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

  // 3b. Zcash: the order's receive mode must be the one asked for (a shielded
  //     request must never be handed a transparent address, or vice versa),
  //     and a quote that already expired unfunded is not payable: the router
  //     replaces such an order on the next create.
  if (isZecSource(gotChain, gotToken)) {
    const zec = zecStatusOf(source);
    const wantReceive = requested?.shielded === true ? 'shielded' : 'transparent';
    if (!zec || zec.receive !== wantReceive) {
      return {
        ok: false,
        code: 'ZEC_RECEIVE_MODE_MISMATCH',
        reason:
          `This link already has a ZEC order that is paid ${zec?.receive ?? 'in an unknown way'}, but you asked for ` +
          `${wantReceive}. Nothing new was created. Pay that order the way it was made, or wait for it to expire unfunded.`,
        moneyDetected: false,
        evidence: { ...evidence, zec },
      };
    }
    if (zec.payinState === 'expired' || zec.payinState === 'reorged') {
      return {
        ok: false,
        code: 'ZEC_QUOTE_EXPIRED',
        reason: `The ZEC price lock on this order has ${zec.payinState === 'reorged' ? 'been disturbed by a reorg' : 'expired'} with nothing received. Do not pay it; re-run pay to get a fresh order.`,
        moneyDetected: false,
        evidence: { ...evidence, zec },
      };
    }
  }

  // 4. The deposit instructions must be complete and payable as they stand.
  //    Lightning carries the BOLT11 in source.lnInvoice with an EMPTY
  //    receiverAddress, so "is there an address" is the wrong question here.
  const deposit = validateDepositInstructions(source);
  if (!deposit.ok) {
    return {
      ok: false,
      code: deposit.code,
      reason: deposit.reason,
      moneyDetected: false,
      evidence,
    };
  }

  return { ok: true, code: null, reason: null, moneyDetected: false, evidence, deposit };
}

/**
 * Post-create verification (PLAN §3 step 4): the create response must agree
 * with the pre-create quoted snapshot. Any drift stops the run.
 */
export function verifyCreateAgainstQuote({ snapshot, created, requested }) {
  const drift = [];

  /**
   * Security-critical fields are REQUIRED on both sides. A create response
   * that simply omits `merchant` or `linkId` must not sail through: without
   * them there is no proof that the rozoPaymentId we are about to fund belongs
   * to the link and merchant that were quoted.
   */
  const require = (field, a, b, normalize = defaultNormalize) => {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === null) {
      drift.push({ field, quoted: null, created: nb, note: 'missing in quote' });
      return;
    }
    if (nb === null) {
      drift.push({ field, quoted: na, created: null, note: 'missing in create response' });
      return;
    }
    if (na !== nb) drift.push({ field, quoted: na, created: nb });
  };

  require('linkId', snapshot?.linkId, created?.linkId);
  require('merchant', snapshot?.merchant, created?.merchant, normalizeMerchant);
  require('original', snapshot?.original, created?.original, normalizeDecimal);
  require('callerPays', snapshot?.callerPays, created?.callerPays, normalizeDecimal);

  // Requested source must be echoed exactly, and must actually be present.
  const wantChain = String(requested?.chainId ?? '').trim();
  const wantToken = String(requested?.tokenSymbol ?? '').trim().toUpperCase();
  const gotChain = String(created?.source?.chainId ?? '').trim();
  const gotToken = String(created?.source?.tokenSymbol ?? '').trim().toUpperCase();
  if (!gotChain || gotChain !== wantChain) {
    drift.push({ field: 'source.chainId', quoted: wantChain, created: gotChain || null });
  }
  if (!gotToken || gotToken !== wantToken) {
    drift.push({ field: 'source.tokenSymbol', quoted: wantToken, created: gotToken || null });
  }

  if (drift.length) {
    return {
      ok: false,
      code: 'CREATE_DRIFT',
      reason: 'The created order does not match what was quoted. Refusing to continue.',
      drift,
    };
  }

  // Pricing invariant. No discount on this line, and the only amount allowed
  // on top of the invoice is a service fee the router states explicitly
  // (serviceFee + feeBps), at or under MAX_SERVICE_FEE_BPS, equal to the fee
  // that rate produces, with callerPays == original + serviceFee exactly.
  // Both the quote and the create response must pass, and must agree.
  const quoted = checkQuotePricing(snapshot);
  if (!quoted.ok) return { ...quoted, drift: [{ field: quoted.field, quoted: quoted.value, created: null, note: 'quote' }] };
  const got = checkPricing(created);
  if (!got.ok) return { ...got, drift: [{ field: got.field, quoted: null, created: got.value }] };
  const feeDrift = [];
  if (quoted.pricing.serviceFee !== got.pricing.serviceFee) {
    feeDrift.push({ field: 'serviceFee', quoted: quoted.pricing.serviceFee, created: got.pricing.serviceFee });
  }
  if (quoted.pricing.feeBps !== got.pricing.feeBps) {
    feeDrift.push({ field: 'feeBps', quoted: quoted.pricing.feeBps, created: got.pricing.feeBps });
  }
  if (feeDrift.length) {
    return {
      ok: false,
      code: 'CREATE_DRIFT',
      reason: 'The created order does not match what was quoted. Refusing to continue.',
      drift: feeDrift,
    };
  }

  return { ok: true, code: null, reason: null, drift: [] };
}

/**
 * Pricing check for a quote snapshot alone (before any order is created):
 * checkPricing, plus the router's top-level `original` must equal the invoice.
 */
export function checkQuotePricing(snapshot) {
  if (
    snapshot?.quotedOriginal !== undefined &&
    snapshot?.quotedOriginal !== null &&
    normalizeDecimal(snapshot.quotedOriginal) !== normalizeDecimal(snapshot.original)
  ) {
    return {
      ok: false,
      code: 'PRICING_VIOLATION',
      reason: `The quote's amount (${snapshot.quotedOriginal}) differs from the invoice amount (${snapshot.original}).`,
      field: 'original',
      value: String(snapshot.quotedOriginal),
      drift: [],
    };
  }
  return checkPricing(snapshot);
}

/**
 * Highest service fee this CLI accepts, in basis points (100 = 1%). Mirrors the
 * router's own code ceiling (MAX_CHECKOUT_WEB_FEE_BPS in rozo-mpprouter
 * src/routes/checkout-web-pricing.ts). A router that asks for more is refused;
 * raising this needs a reviewed change here, not a server setting.
 */
export const MAX_SERVICE_FEE_BPS = 100;

const USDC_DECIMALS = 6;
const ATOMIC_PER_CENT = 10_000n;

/**
 * The fee a rate produces, exactly as the router computes it: original x bps /
 * 10,000, rounded UP to a whole cent, in atomic USDC (6 decimals).
 */
export function serviceFeeAtomicFor(originalAtomic, feeBps) {
  if (feeBps === 0 || originalAtomic === 0n) return 0n;
  const divisor = 10_000n * ATOMIC_PER_CENT;
  return ((originalAtomic * BigInt(feeBps) + divisor - 1n) / divisor) * ATOMIC_PER_CENT;
}

function formatAtomicUsd(atomic) {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

function parseFeeBps(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/**
 * Validate the pricing block of a quote snapshot or a create response:
 * { original, serviceFee, callerPays, feeBps, discount }.
 *
 * Accepted shapes, and nothing else:
 *   - no fee fields at all: callerPays must equal original (zero fee);
 *   - serviceFee AND feeBps both present: feeBps an integer 0..MAX_SERVICE_FEE_BPS,
 *     serviceFee exactly the fee that feeBps produces on original, and
 *     callerPays exactly original + serviceFee.
 * A fee without its rate, a rate without its fee, an unparsable amount or any
 * arithmetic mismatch is refused. Fails closed.
 *
 * @returns {{ok:true, pricing:{original:string, serviceFee:string, callerPays:string, feeBps:number}}
 *          | {ok:false, code:string, reason:string, field:string, value:any}}
 */
export function checkPricing(obj) {
  const bad = (code, field, value, reason) => ({ ok: false, code, reason, field, value: value ?? null, drift: [] });
  const disc = obj?.discount;
  if (disc !== undefined && disc !== null && normalizeDecimal(disc) !== '0') {
    return bad('NO_DISCOUNT_VIOLATION', 'discount', String(disc), `Server reported a discount of "${disc}"; this flow must charge the full invoice.`);
  }
  const parse = (field) => {
    const raw = defaultNormalize(obj?.[field]);
    if (raw === null) return { missing: true };
    try {
      return { atomic: toAtomic(raw, USDC_DECIMALS) };
    } catch {
      return { invalid: raw };
    }
  };
  const original = parse('original');
  const callerPays = parse('callerPays');
  for (const [field, v] of [['original', original], ['callerPays', callerPays]]) {
    if (v.missing) return bad('PRICING_VIOLATION', field, null, `The ${field} amount is missing.`);
    if (v.invalid !== undefined) return bad('PRICING_VIOLATION', field, v.invalid, `The ${field} amount "${v.invalid}" is not a USD amount.`);
  }
  const feeGiven = defaultNormalize(obj?.serviceFee) !== null;
  const bpsGiven = obj?.feeBps !== undefined && obj?.feeBps !== null && String(obj.feeBps).trim() !== '';
  let feeAtomic = 0n;
  let feeBps = 0;
  if (feeGiven || bpsGiven) {
    if (!feeGiven || !bpsGiven) {
      return bad(
        'PRICING_VIOLATION',
        feeGiven ? 'feeBps' : 'serviceFee',
        null,
        'The server stated a service fee without its rate, or a rate without the fee. Refusing to guess.',
      );
    }
    feeBps = parseFeeBps(obj.feeBps);
    if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > MAX_SERVICE_FEE_BPS) {
      return bad(
        'PRICING_VIOLATION',
        'feeBps',
        String(obj.feeBps),
        `Service fee rate ${obj.feeBps} bps is outside 0..${MAX_SERVICE_FEE_BPS} bps; this CLI does not accept it.`,
      );
    }
    const fee = parse('serviceFee');
    if (fee.invalid !== undefined) return bad('PRICING_VIOLATION', 'serviceFee', fee.invalid, `The service fee "${fee.invalid}" is not a USD amount.`);
    feeAtomic = fee.atomic;
    const expected = serviceFeeAtomicFor(original.atomic, feeBps);
    if (feeAtomic !== expected) {
      return bad(
        'PRICING_VIOLATION',
        'serviceFee',
        String(obj.serviceFee),
        `Service fee ${obj.serviceFee} is not ${feeBps} bps of ${obj.original} (expected ${formatAtomicUsd(expected)}).`,
      );
    }
  }
  if (callerPays.atomic !== original.atomic + feeAtomic) {
    return bad(
      'PRICING_VIOLATION',
      'callerPays',
      String(obj.callerPays),
      `callerPays (${obj.callerPays}) is not the invoice amount (${obj.original}) plus the stated service fee ` +
        `(${formatAtomicUsd(feeAtomic)}).`,
    );
  }
  return {
    ok: true,
    code: null,
    reason: null,
    pricing: {
      original: formatAtomicUsd(original.atomic),
      serviceFee: formatAtomicUsd(feeAtomic),
      callerPays: formatAtomicUsd(callerPays.atomic),
      feeBps,
    },
  };
}

function defaultNormalize(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * The merchant may arrive as a bare string or as `{ name }` depending on which
 * service serialized it. Compare the human name either way.
 */
export function normalizeMerchant(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const name = v.name ?? v.merchantName ?? null;
    return name ? String(name).trim() || null : null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
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

  // Payability must be PROVED, not assumed. Incomplete state is not a pass:
  // a response missing usageCount, maxUsage or a v3 status tells us nothing
  // about whether someone else has consumed the link in the meantime.
  if (protocolVersion === 'v3') {
    if (!cb.status) {
      return {
        ok: false,
        code: 'LINK_PAYABILITY_UNKNOWN',
        reason: 'The Payment Session response carries no status; cannot prove it is still payable.',
        derived,
      };
    }
    if (cb.status !== 'PAYMENT_SESSION_STATUS_CREATED') {
      return {
        ok: false,
        code: 'LINK_NO_LONGER_PAYABLE',
        reason: `Payment Session status is ${cb.status}; only PAYMENT_SESSION_STATUS_CREATED is payable.`,
        derived,
      };
    }
    return { ok: true, code: null, reason: null, derived };
  }

  const usage = Number(cb.usageCount);
  const max = Number(cb.maxUsage);
  if (
    cb.usageCount === null ||
    cb.usageCount === undefined ||
    cb.maxUsage === null ||
    cb.maxUsage === undefined ||
    !Number.isFinite(usage) ||
    !Number.isFinite(max)
  ) {
    return {
      ok: false,
      code: 'LINK_PAYABILITY_UNKNOWN',
      reason:
        'The payment link response is missing usageCount/maxUsage; cannot prove it has not ' +
        'already been used.',
      derived,
    };
  }
  if (usage >= max) {
    return {
      ok: false,
      code: 'LINK_NO_LONGER_PAYABLE',
      reason: `Payment link already used (${usage}/${max}).`,
      derived,
    };
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
export function classifyStatus({
  payment,
  routerState,
  coinbase,
  now = Date.now(),
  viewsFailed = false,
  provider = 'coinbase',
}) {
  const bitrefill = provider === 'bitrefill';
  const source = payment?.source || {};
  const hasTx = Boolean(source.txHash);
  const confirmed = Boolean(source.confirmedAt);
  const signal = receiptSignal(source);
  const receipt = signal.receipt;
  const moneyDetected = hasTx || confirmed || signal.money;
  const routerStatus = routerState?.status ?? null;

  const mk = (state, detail, opts = {}) => ({
    state,
    moneyDetected: Boolean(moneyDetected),
    terminal: Boolean(opts.terminal),
    escalate: Boolean(opts.escalate),
    unknown: Boolean(opts.unknown),
    detail,
    receipt,
    receiptUnparsable: signal.unparsable,
    routerStatus,
  });

  // We could not read the backend at all. Saying "awaiting deposit" here would
  // be a claim we have no evidence for.
  if (viewsFailed || (!payment?.status && !routerStatus && !coinbase)) {
    return mk(
      'unknown',
      'Could not read the order state from the backend. This is NOT evidence that nothing has ' +
        'been paid — do not act on it.',
      { unknown: true },
    );
  }

  if (signal.unparsable) {
    return mk(
      'stuck_after_payment',
      'The order reports an amountReceived that cannot be read. Treating it as funded until a ' +
        'human confirms otherwise.',
      { escalate: true },
    );
  }

  // Settlement of the Coinbase invoice is proved ONLY by the router saying it
  // paid, or by Coinbase reporting the resource settled. The intents-side
  // `payment_completed` is the bridge lifecycle finishing, which happens
  // before (and independently of) the Coinbase leg.
  // A failed fulfilment is checked FIRST. A Coinbase link can read as settled
  // (v1 usageCount >= maxUsage) because someone else paid it, while this
  // order's pay-in sits stranded; that must never be reported as settled.
  if (routerStatus === 'failed_pay_invoice' || routerStatus === 'failed_insufficient_balance') {
    return mk(
      'stuck_after_payment',
      `Fulfillment failed (${routerStatus}) after the pay-in. Do not pay again — escalate for ` +
        'manual reconciliation.',
      { terminal: false, escalate: true },
    );
  }
  // Settled needs Coinbase to show the capture. The router saying `paid` is
  // not enough on its own (Coinbase can still be authorizing), and a Coinbase
  // capture while the router is mid-payment is waited on, not reported: the
  // same rule receipt.mjs applies (paymentOutcomeFor / merchantSettlementProved).
  // Bitrefill is unaffected: its proof is the Rozo payout, handled below.
  if (!bitrefill && coinbase?.settled === true && (routerStatus === null || routerStatus === 'paid')) {
    return mk('settled', 'Coinbase invoice settled by the funder wallet.', { terminal: true });
  }
  if (!bitrefill && routerStatus === 'paid') {
    return mk(
      'paying_coinbase',
      'The funder wallet paid, but Coinbase has not shown the capture yet. Keep polling; do not pay again.',
    );
  }
  // Coinbase settled while the router is mid-payment (or on another state):
  // not settled yet; the payment status below decides what to show.

  // A native coin order is priced with a tolerance: the backend accepts a
  // payment slightly under the quoted coin amount (for example an exchange
  // withdrawal that lost its fee) and moves it on. Once the backend has moved
  // such an order past the pay-in, follow the backend instead of escalating.
  const nativeAccepted =
    isNativeSource(source.chainId, source.tokenSymbol) &&
    NATIVE_PROGRESS_STATUSES.has(payment?.status);
  if (moneyDetected && receipt && receipt.state === 'underpaid' && !nativeAccepted) {
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

  // Bitrefill: the Rozo payout IS the payment. Once the intent reports the
  // payout (or the whole payment) completed, the exact USDC amount has been
  // delivered to the Bitrefill address, so there is no paying_coinbase stage.
  // payment_completed alone is not proof the payout landed; it counts only
  // with a payout tx hash.
  if (bitrefill) {
    const payoutTx = Boolean(payment?.destination?.txHash);
    if (payment?.status === 'payment_payout_completed' || (payment?.status === 'payment_completed' && payoutTx)) {
      return mk('settled', 'USDC delivered to the Bitrefill invoice address on Base.', {
        terminal: true,
      });
    }
    if (payment?.status === 'payment_completed') {
      return mk('bridging', 'Payment completed but no payout transaction is visible yet. Keep polling.');
    }
  }

  switch (payment?.status) {
    case 'payment_unpaid': {
      if (moneyDetected) {
        return mk('payin_detected', 'Pay-in seen on chain, waiting for confirmations.');
      }
      const exp = payment?.expiresAt ? Date.parse(payment.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp < now) {
        return mk('expired_unfunded', 'The order expired before any funds arrived. This order can no longer be paid.', {
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
      // Bridge lifecycle complete — NOT proof the Coinbase invoice was paid.
      // That proof is handled above (routerStatus === 'paid' / settled).
      return mk(
        'paying_coinbase',
        'The bridge leg completed, but Coinbase settlement is not yet confirmed. Keep polling.',
      );
    case 'payment_expired':
      return moneyDetected
        ? mk('stuck_after_payment', 'Order expired AFTER funds arrived — escalate immediately.', {
            escalate: true,
          })
        : mk('expired_unfunded', 'Order expired unfunded. This order can no longer be paid.', { terminal: true });
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
    moneyDetected ? 'stuck_after_payment' : 'unknown',
    `Unrecognized backend status "${payment?.status ?? 'unknown'}"; not assuming anything about it.`,
    { escalate: Boolean(moneyDetected), unknown: !moneyDetected },
  );
}
