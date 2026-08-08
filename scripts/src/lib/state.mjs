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
  // Under the lock: this is a read-modify-write of the same file claimSend
  // owns. Unlocked, a re-create racing a claim can read the pre-claim state
  // and write it back, erasing the send record and reopening double-send.
  return withLock(() => createOrderRecordUnlocked(record));
}

function createOrderRecordUnlocked(record) {
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
  // Under the lock, for the same reason as createOrderRecord: an unlocked
  // read-modify-write here can clobber a send claim written concurrently.
  return withLock(() => {
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
  });
}

/**
 * Claim the exclusive right to send for this order, and charge the spend caps,
 * as ONE atomic operation under the cross-process lock.
 *
 * Throws ALREADY_SENT if any prior send record exists (submitted, confirmed or
 * even merely claimed) — we never blind-retry, because a claimed-but-unknown
 * send may well be on chain.
 */
export function claimSend(rozoPaymentId, intent, { skipCaps = false } = {}) {
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

    const caps = skipCaps ? null : assertPaymentLimit(state.invoiceAmount);

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
  // Every read-modify-write of a state file holds the lock, so no writer can
  // ever read a stale copy and write back over another writer's change.
  return withLock(() => {
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
  });
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

/**
 * The one hot-wallet limit (PLAN §5.3, simplified 2026-08).
 *
 * Exactly one rule: a single payment may not exceed MAX_PAYMENT_USD. There is
 * no cumulative session cap and no override flag — an amount above the limit
 * is a hard refusal, and the answer is to pay it from a wallet you control
 * (Mode A) rather than from an automated hot wallet.
 *
 * $1,100 is sized to clear the largest real invoice on this route (a $1,000
 * credit purchase plus its 5% fee) with headroom.
 */
export const MAX_PAYMENT_USD = 1100;

/**
 * Depends only on this order's own amount, so it needs no lock and no shared
 * state. claimSend still calls it inside the lock, which is harmless.
 */
export function assertPaymentLimit(invoiceUsd) {
  // Number(null) and Number('') are both 0, which would read as a free
  // payment. A missing amount is a refusal, not a zero.
  if (invoiceUsd === null || invoiceUsd === undefined || String(invoiceUsd).trim() === '') {
    throw new SkillError('BAD_INVOICE_AMOUNT', 'Cannot evaluate the payment limit without a USD amount.');
  }
  const usd = Number(invoiceUsd);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new SkillError('BAD_INVOICE_AMOUNT', 'Cannot evaluate the payment limit without a USD amount.');
  }
  if (usd > MAX_PAYMENT_USD) {
    throw new SkillError(
      'CAP_PER_TX',
      `$${usd} is above the $${MAX_PAYMENT_USD} per-payment limit for automated sending. ` +
        'This limit has no override. Pay this invoice from a wallet you control instead — ' +
        'that path needs no key and has no limit.',
    );
  }
  return { usd, limitUsd: MAX_PAYMENT_USD };
}
