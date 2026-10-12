/**
 * Expiry margins (PLAN §3 "Expiry guard", fix P0-6 / R2-6).
 *
 * We refuse to display-for-payment or to sign when
 *   now > min(intent expiresAt, coinbase preApprovalExpiry) - margin
 * where the margin must cover submission + confirmations + bridge + Coinbase
 * settlement on the chosen chain.
 *
 * Native coin orders (ETH, BNB, POL, SOL) add a third deadline: the price
 * lock, `quoteExpiresAt`. The order itself stays open for hours after it, but
 * a payment that arrives after the lock is valued at the arrival price and can
 * end up short. So for a native order the lock is part of the effective
 * deadline, and a native order whose lock is missing is refused, not waved
 * through.
 *
 * Lightning is not margin-based in the same way: the BOLT11 expiry is just
 * another deadline, and we additionally require >= 10 minutes of BOLT11
 * validity. Inside that window the caller must ask the backend for a fresh
 * invoice rather than "hoping".
 *
 * A missing or unparsable deadline is an abort, never a pass.
 */

export const MINUTE = 60_000;

/** Per-chain settlement margin in milliseconds. */
export const MARGINS_MS = {
  1: 10 * MINUTE,
  56: 10 * MINUTE,
  137: 10 * MINUTE,
  8453: 10 * MINUTE,
  42161: 10 * MINUTE,
  900: 5 * MINUTE,
  1500: 10 * MINUTE,
  lightning: 10 * MINUTE,
};

/** Minimum BOLT11 validity we are willing to hand to a payer. */
export const BOLT11_MIN_VALIDITY_MS = 10 * MINUTE;

export const DEFAULT_MARGIN_MS = 10 * MINUTE;

/** Default status --watch window when no --timeout is given (non-Lightning). */
export const DEFAULT_WATCH_MS = 10 * MINUTE;

/** Upper bound on the Lightning default watch window. */
export const LIGHTNING_WATCH_CAP_MS = 60 * MINUTE;

/**
 * Default watch window for a Lightning order: as long as the BOLT11 can still
 * be paid, capped at LIGHTNING_WATCH_CAP_MS. Watching a fixed 10 minutes on an
 * invoice that is valid for 40 gave up while the payer could still pay. An
 * unknown or already expired invoice falls back to `fallbackMs`.
 *
 * @param {*} expiresAt   invoice deadline (ISO string or epoch ms)
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.fallbackMs]
 */
export function lightningWatchMs(expiresAt, { now = Date.now(), fallbackMs = DEFAULT_WATCH_MS } = {}) {
  const at = parseDeadline(expiresAt);
  if (at === null) return fallbackMs;
  const remaining = at - now;
  if (!(remaining > 0)) return fallbackMs;
  return Math.min(remaining, LIGHTNING_WATCH_CAP_MS);
}

/**
 * Seconds to watch for settlement after pay. An explicit --timeout wins. A
 * Lightning order is otherwise watched for as long as its invoice can still be
 * paid (at most 60 minutes); other coins keep the --timeout default.
 */
export function settlementWatchSeconds(opts, deposit, now = Date.now()) {
  const fallbackMs = Number(opts.timeout ?? 900) * 1000;
  if (opts.timeoutExplicit) return Math.round(fallbackMs / 1000);
  // Exact-out orders: Lightning watches its invoice, a native coin its price lock.
  const until = deposit?.lnInvoice ? deposit.expiresAt : deposit?.quoteExpiresAt;
  if (!until) return Math.round(fallbackMs / 1000);
  return Math.ceil(lightningWatchMs(until, { now, fallbackMs }) / 1000);
}

/** Whole minutes of validity left on a deadline, or null when unknown. 0 once expired. */
export function minutesRemaining(expiresAt, now = Date.now()) {
  const at = parseDeadline(expiresAt);
  if (at === null) return null;
  return Math.max(0, Math.floor((at - now) / MINUTE));
}

/**
 * Human duration for a remaining window: "47m", "1h 12m", "45s".
 *
 * An ISO timestamp alone forces the reader to do date arithmetic under time
 * pressure. A real payment nearly missed its window because the deposit block
 * only showed the deadline, not how long was left.
 */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms <= 0) return 'expired';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Render a deadline the way someone deciding whether to go and fetch a wallet
 * needs it: how long they have, and what time that is on their own clock.
 *
 * The raw ISO timestamp is UTC and demands mental arithmetic at exactly the
 * moment the user is trying to work out whether they can make it. The ISO form
 * stays in --json for machines.
 *
 * @param {string} iso   deadline, ISO 8601
 * @param {object} [opts]
 * @param {number} [opts.now]     epoch ms, injectable so tests are deterministic
 * @param {string} [opts.locale]  passed to toLocaleTimeString
 * @param {string} [opts.timeZone]
 * @returns {string|null} null when the input is not a usable date
 */
export function formatDeadline(iso, { now = Date.now(), locale, timeZone } = {}) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  const msLeft = at.getTime() - now;
  if (msLeft <= 0) return 'expired';

  const minutes = Math.round(msLeft / 60000);
  const human =
    minutes < 1
      ? 'less than a minute'
      : minutes < 60
        ? `about ${minutes} minute${minutes === 1 ? '' : 's'}`
        : `about ${Math.floor(minutes / 60)}h ${minutes % 60}m`;

  const clock = at.toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  return `in ${human}, at ${clock} local time`;
}

export function marginFor(chainId) {
  const key = String(chainId);
  return MARGINS_MS[key] ?? MARGINS_MS[chainId] ?? DEFAULT_MARGIN_MS;
}

/**
 * Parse a deadline that may arrive as an ISO string, a millisecond epoch, or a
 * second epoch. Returns epoch milliseconds, or null when unusable.
 */
export function parseDeadline(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below year 2286 in ms is a seconds epoch.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Evaluate all deadlines for one order.
 *
 * @param {object} input
 * @param {number} input.now              epoch ms
 * @param {string|number} input.chainId
 * @param {*} input.intentExpiresAt       payments/<id>.expiresAt
 * @param {*} input.coinbaseExpiry        Coinbase preApprovalExpiry
 * @param {*} [input.bolt11ExpiresAt]     Lightning only
 * @param {*} [input.quoteExpiresAt]      native coin orders only: the price lock.
 *                                        Pass it (even null) for every native
 *                                        order; undefined means "not native".
 * @returns {{ok:boolean, code:string|null, reason:string|null, marginMs:number,
 *            effectiveDeadlineMs:number|null, msRemaining:number|null,
 *            msOfSlack:number|null, deadlines:object}}
 */
export function checkExpiry({
  now,
  chainId,
  intentExpiresAt,
  coinbaseExpiry,
  bolt11ExpiresAt = undefined,
  quoteExpiresAt = undefined,
}) {
  const marginMs = marginFor(chainId);
  const intentMs = parseDeadline(intentExpiresAt);
  const coinbaseMs = parseDeadline(coinbaseExpiry);
  const bolt11Ms = bolt11ExpiresAt === undefined ? undefined : parseDeadline(bolt11ExpiresAt);
  const native = quoteExpiresAt !== undefined;
  const quoteMs = native ? parseDeadline(quoteExpiresAt) : null;

  const deadlines = { intentMs, coinbaseMs, bolt11Ms: bolt11Ms ?? null, quoteMs };

  const base = {
    marginMs,
    effectiveDeadlineMs: null,
    msRemaining: null,
    msOfSlack: null,
    deadlines,
  };

  if (intentMs === null) {
    return {
      ...base,
      ok: false,
      code: 'EXPIRY_UNPARSABLE',
      reason: 'Intent expiresAt is missing or unparsable.',
    };
  }
  if (coinbaseMs === null) {
    return {
      ...base,
      ok: false,
      code: 'EXPIRY_UNPARSABLE',
      reason: 'Coinbase preApprovalExpiry is missing or unparsable.',
    };
  }
  if (native && quoteMs === null) {
    return {
      ...base,
      ok: false,
      code: 'EXPIRY_UNPARSABLE',
      reason:
        'This native coin order carries no price lock (quoteExpiresAt), so the coin amount cannot ' +
        'be trusted to be honoured. Refusing to treat it as payable.',
    };
  }

  const effective = native ? Math.min(intentMs, coinbaseMs, quoteMs) : Math.min(intentMs, coinbaseMs);
  const lockBinds = native && quoteMs <= Math.min(intentMs, coinbaseMs);
  const msRemaining = effective - now;
  const msOfSlack = msRemaining - marginMs;
  const withDeadline = {
    ...base,
    effectiveDeadlineMs: effective,
    msRemaining,
    msOfSlack,
  };

  if (msRemaining <= 0) {
    return {
      ...withDeadline,
      ok: false,
      code: lockBinds ? 'QUOTE_EXPIRED' : 'EXPIRED',
      reason: lockBinds
        ? 'The coin price for this order was locked until quoteExpiresAt, and that has passed. A ' +
          'payment now would be valued at the price when it arrives and may fall short. Do not ' +
          'send it; let the order expire unfunded and start a new one.'
        : 'The order or the Coinbase link has already expired.',
    };
  }
  if (msOfSlack <= 0) {
    return {
      ...withDeadline,
      ok: false,
      code: lockBinds ? 'QUOTE_EXPIRY_MARGIN' : 'EXPIRY_MARGIN',
      reason:
        `Only ${Math.floor(msRemaining / 1000)}s left before the earliest deadline` +
        `${lockBinds ? ' (the coin price lock)' : ''}; ` +
        `this chain needs a ${Math.floor(marginMs / 60000)} min safety margin.`,
    };
  }

  // Lightning: BOLT11 validity is a separate, additional gate.
  if (bolt11ExpiresAt !== undefined) {
    if (bolt11Ms === null) {
      return {
        ...withDeadline,
        ok: false,
        code: 'EXPIRY_UNPARSABLE',
        reason: 'BOLT11 invoice expiry is missing or unparsable.',
      };
    }
    const bolt11Remaining = bolt11Ms - now;
    if (bolt11Remaining < BOLT11_MIN_VALIDITY_MS) {
      return {
        ...withDeadline,
        ok: false,
        code: 'BOLT11_TOO_SHORT',
        reason:
          `BOLT11 invoice has ${Math.max(0, Math.floor(bolt11Remaining / 1000))}s of ` +
          `validity left; at least 10 min is required. Request a fresh invoice.`,
      };
    }
  }

  return { ...withDeadline, ok: true, code: null, reason: null };
}

/**
 * The price-lock deadline to pass to checkExpiry as `quoteExpiresAt`.
 *
 * Returns undefined for a non-native order (no lock applies). For a native
 * order it returns the EARLIEST parsable lock among the live payment
 * (`quoteExpiresAt`, top level or on `source`) and any locally recorded one, or
 * null when none is known, which checkExpiry treats as a refusal. A lock can
 * only ever move earlier, never later.
 *
 * @param {object} args
 * @param {boolean} args.native   is this a native coin order
 * @param {object} [args.payment] payments/<id> response
 * @param {...*} [args.others]    further candidate deadlines (ISO / epoch)
 */
export function priceLockFor({ native, payment = null, others = [] }) {
  if (!native) return undefined;
  const candidates = [payment?.quoteExpiresAt, payment?.source?.quoteExpiresAt, ...others]
    .map(parseDeadline)
    .filter((ms) => ms !== null);
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates)).toISOString();
}
