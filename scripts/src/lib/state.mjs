/**
 * Local state store (PLAN §5.2 — send-once idempotency).
 *
 * One JSON file per order at  ~/.rozo-checkout/state/<rozoPaymentId>.json
 * (override the root with ROZO_CHECKOUT_STATE_DIR, mainly for tests).
 *
 * Writes are atomic: a temp file in the same directory is written, fsynced,
 * then renamed over the target. A half-written state file could otherwise make
 * a script believe no send has happened and send a second time.
 *
 * The file records, in order of the run:
 *   1. the created order (createOrderRecord)
 *   2. a pre-send intent, claimed exclusively (claimSend)
 *   3. the broadcast result / tx hash (recordSendResult)
 *
 * Truth about receipt is always the backend (`source.confirmedAt` /
 * `amountReceived`), never this file. This file exists to stop a SECOND send.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SkillError } from './output.mjs';

/**
 * Cross-process mutual exclusion.
 *
 * Atomic rename protects a single file from being torn; it does NOT stop two
 * processes from both reading `send == null` and both writing a claim. Every
 * check-then-act sequence that could authorise a transfer — the send claim and
 * the cumulative spend cap — runs inside this lock.
 *
 * The lock is a file created with O_EXCL in the state root. A lock older than
 * LOCK_STALE_MS is assumed to belong to a crashed process and is reclaimed.
 */
export const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;

function lockPath() {
  return path.join(stateRoot(), '.send.lock');
}

/** Synchronous sleep — these are short waits inside a critical section. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquire(file) {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

/** Run `fn` while holding the exclusive lock. */
export function withLock(fn) {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    if (tryAcquire(file)) break;

    // Reclaim a stale lock, but only via an atomic rename-out so two waiters
    // cannot both decide to steal it.
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > LOCK_STALE_MS) {
        const stolen = `${file}.stale.${crypto.randomBytes(4).toString('hex')}`;
        try {
          fs.renameSync(file, stolen);
          fs.unlinkSync(stolen);
        } catch {
          // Another waiter got there first; fall through and retry.
        }
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }

    if (Date.now() > deadline) {
      throw new SkillError(
        'LOCK_TIMEOUT',
        'Another rozo-checkout process is holding the send lock. Refusing to proceed rather ' +
          'than risk a concurrent second send.',
      );
    }
    sleepSync(LOCK_POLL_MS);
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already released.
    }
  }
}

export function stateRoot() {
  return process.env.ROZO_CHECKOUT_STATE_DIR || path.join(os.homedir(), '.rozo-checkout', 'state');
}

export function statePath(rozoPaymentId) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(rozoPaymentId || ''))) {
    throw new SkillError('BAD_ROZO_PAYMENT_ID', 'Refusing to build a state path from that id.');
  }
  return path.join(stateRoot(), `${rozoPaymentId}.json`);
}

/** Write JSON atomically: temp file in the same dir, fsync, rename. */
export function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readState(rozoPaymentId) {
  const file = statePath(rozoPaymentId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new SkillError('STATE_UNREADABLE', `Cannot read local state: ${err.code}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt state file must not be treated as "no send has happened".
    throw new SkillError(
      'STATE_CORRUPT',
      'The local state file for this order is corrupt. Refusing to act; inspect it manually.',
    );
  }
}

/**
 * Record a created order before the deposit address is shown to anyone.
 * Idempotent: re-running create for the same order keeps the original
 * createdAt and any send records.
 */
export function createOrderRecord(record) {
  const { rozoPaymentId } = record;
  const existing = readState(rozoPaymentId);
  const next = {
    version: 1,
    rozoPaymentId,
    linkId: record.linkId,
    paymentLink: record.paymentLink ?? null,
    merchant: record.merchant ?? null,
    invoiceAmount: record.invoiceAmount ?? null,
    source: record.source,
    receiverAddress: record.receiverAddress,
    receiverMemo: record.receiverMemo ?? null,
    amount: record.amount,
    amountUnit: record.amountUnit ?? null,
    expiresAt: record.expiresAt ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmation: existing?.confirmation ?? null,
    send: existing?.send ?? null,
  };
  writeAtomic(statePath(rozoPaymentId), next);
  return next;
}

/**
 * Digest over the deposit instructions a human was actually shown. The send
 * scripts recompute this from the LIVE payment response and refuse to sign if
 * it differs — so a confirmation can only ever authorise the exact deposit it
 * was given for.
 */
export function depositDigest(source) {
  const canonical = JSON.stringify({
    chainId: String(source?.chainId ?? ''),
    tokenSymbol: String(source?.tokenSymbol ?? '').toUpperCase(),
    tokenAddress: String(source?.tokenAddress ?? ''),
    receiverAddress: String(source?.receiverAddress ?? ''),
    receiverMemo: source?.receiverMemo ?? null,
    amount: String(source?.amount ?? ''),
    amountUnit: source?.amountUnit ?? null,
    lnInvoice: source?.lnInvoice ?? null,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Record that a human was shown the full deposit instructions and said yes
 * (PLAN §3 step 6b). This is what makes a later `--send` legitimate.
 */
export function recordConfirmation(rozoPaymentId, { source, invoiceAmount, tier }) {
  const state = readState(rozoPaymentId);
  if (!state) {
    throw new SkillError('NO_ORDER_STATE', 'Cannot confirm an order with no local record.');
  }
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    confirmation: {
      confirmedAt: new Date().toISOString(),
      depositDigest: depositDigest(source),
      invoiceAmount: invoiceAmount ?? state.invoiceAmount ?? null,
      tier: tier ?? null,
    },
  };
  writeAtomic(statePath(rozoPaymentId), next);
  return next;
}

/**
 * Claim the exclusive right to send for this order, and charge the spend caps,
 * as ONE atomic operation under the cross-process lock.
 *
 * Throws ALREADY_SENT if any prior send record exists (submitted, confirmed or
 * even merely claimed) — we never blind-retry, because a claimed-but-unknown
 * send may well be on chain.
 */
export function claimSend(rozoPaymentId, intent, { allowLarge = false, skipCaps = false } = {}) {
  return withLock(() => {
    const state = readState(rozoPaymentId);
    if (!state) {
      throw new SkillError(
        'NO_ORDER_STATE',
        'No local record for this order. Run create-order.js in this same session first.',
      );
    }
    if (state.send) {
      throw new SkillError(
        'ALREADY_SENT',
        `A send was already recorded for this order at ${state.send.claimedAt} ` +
          `(status: ${state.send.status}). Refusing to send twice. ` +
          'Check the backend for the pay-in before doing anything else.',
        { send: state.send },
      );
    }

    // The cap must be evaluated and consumed inside the same lock as the
    // claim, otherwise two processes can each see themselves as under budget.
    const caps = skipCaps
      ? null
      : assertSpendCapsUnlocked(state.invoiceAmount, { allowLarge, excludeId: rozoPaymentId });

    const next = {
      ...state,
      updatedAt: new Date().toISOString(),
      send: {
        status: 'claimed',
        claimedAt: new Date().toISOString(),
        chainId: intent.chainId,
        tokenSymbol: intent.tokenSymbol,
        from: intent.from,
        to: intent.to,
        amountAtomic: intent.amountAtomic,
        memo: intent.memo ?? null,
        nonceBefore: intent.nonceBefore ?? null,
        expectedTxHash: intent.expectedTxHash ?? null,
        txHash: null,
      },
    };
    writeAtomic(statePath(rozoPaymentId), next);
    return { state: next, caps };
  });
}

/** Attach the broadcast outcome. `status` is submitted | confirmed | ambiguous | failed. */
export function recordSendResult(rozoPaymentId, { status, txHash = null, note = null }) {
  const state = readState(rozoPaymentId);
  if (!state || !state.send) {
    throw new SkillError('NO_SEND_CLAIM', 'No send claim to update for this order.');
  }
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    send: {
      ...state.send,
      status,
      txHash: txHash ?? state.send.txHash,
      note,
      resolvedAt: new Date().toISOString(),
    },
  };
  writeAtomic(statePath(rozoPaymentId), next);
  return next;
}

/**
 * Find the most recent local record for a Coinbase linkId.
 *
 * The router's link-only status response does not resolve `rozo_payment_id`,
 * so this is how `status.js --link-id` reaches the authoritative pay-in view
 * for an order this machine created.
 */
export function findByLinkId(linkId) {
  const dir = stateRoot();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s?.linkId !== linkId) continue;
      if (!best || String(s.createdAt) > String(best.createdAt)) best = s;
    } catch {
      // Skip unreadable neighbours; this is a convenience lookup only.
    }
  }
  return best;
}

/** Cumulative USD already claimed in this state dir, for the per-session cap. */
export function sessionSpendUsd({ excludeId = null } = {}) {
  const dir = stateRoot();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let total = 0;
  for (const f of files) {
    if (excludeId && f === `${excludeId}.json`) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s?.send && ['claimed', 'submitted', 'confirmed', 'ambiguous'].includes(s.send.status)) {
        const usd = Number(s.invoiceAmount);
        // An unreadable amount on a real claim must not count as zero.
        total += Number.isFinite(usd) ? usd : MAX_TX_USD;
      }
    } catch {
      // A corrupt neighbour must not silently lower the running total, so we
      // count it as the maximum single-tx cap.
      total += MAX_TX_USD;
    }
  }
  return total;
}

export const MAX_TX_USD = 100;
export const MAX_SESSION_USD = 200;

/**
 * Hot-wallet spend caps (PLAN §5.3). Assumes the caller already holds the
 * lock — use `assertSpendCaps` (or `claimSend`) from outside.
 */
export function assertSpendCapsUnlocked(invoiceUsd, { allowLarge = false, excludeId = null } = {}) {
  const usd = Number(invoiceUsd);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new SkillError('BAD_INVOICE_AMOUNT', 'Cannot evaluate spend caps without a USD amount.');
  }
  if (usd > MAX_TX_USD && !allowLarge) {
    throw new SkillError(
      'CAP_PER_TX',
      `$${usd} exceeds the $${MAX_TX_USD} per-transaction cap. Re-run with --yes-large to override.`,
    );
  }
  const prior = sessionSpendUsd({ excludeId });
  if (prior + usd > MAX_SESSION_USD) {
    throw new SkillError(
      'CAP_SESSION',
      `This send would bring cumulative spend to $${(prior + usd).toFixed(2)}, past the ` +
        `$${MAX_SESSION_USD} session cap. Clear or archive the state directory to start a new session.`,
    );
  }
  return { priorUsd: prior, totalUsd: prior + usd };
}

/** Lock-taking wrapper, for callers that only want to preview the caps. */
export function assertSpendCaps(invoiceUsd, opts = {}) {
  return withLock(() => assertSpendCapsUnlocked(invoiceUsd, opts));
}
