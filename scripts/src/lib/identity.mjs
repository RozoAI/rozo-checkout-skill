/**
 * Anonymous order attribution (router contract of 2026-10-09).
 *
 * Two optional fields ride along in `attribution` on create-invoice:
 *
 *   install_id    a random UUID v4 generated once per install and kept in the
 *                 local preferences file (~/.rozo-checkout/prefs.json). It is
 *                 not derived from anything about the machine or the user; it
 *                 only lets repeat orders from the same install be counted as
 *                 one payer. Delete the file to get a new one.
 *
 *   account_hash  lowercase hex sha256 of "rozo-acct-v1:" + OPENROUTER_API_KEY,
 *                 sent only when that key is present in the environment. Only
 *                 the API key is used: it is high-entropy, so the hash cannot
 *                 be reversed by guessing. A low-entropy account id is never
 *                 hashed, because the hash is visible to anyone holding an
 *                 order id. The key is hashed in memory and never sent,
 *                 logged or written anywhere.
 *
 * Both are reporting only: no privilege, and nothing here can fail an order.
 * Set ROZO_CHECKOUT_ANON_ID=off to send neither.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { prefsPath, readPrefs, savePrefs } from './prefs.mjs';

export const ACCOUNT_HASH_PREFIX = 'rozo-acct-v1:';

/** Same pattern the router validates with; anything else is dropped there. */
export const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ACCOUNT_HASH_RE = /^[0-9a-f]{64}$/;

export function isValidInstallId(value) {
  return typeof value === 'string' && INSTALL_ID_RE.test(value);
}

/** True when the user switched anonymous attribution off. */
export function attributionDisabled(env = process.env) {
  const v = String(env.ROZO_CHECKOUT_ANON_ID ?? '').trim().toLowerCase();
  return ['off', '0', 'false', 'no'].includes(v);
}

const INIT_LOCK_WAIT_MS = 2_000;
const INIT_LOCK_STALE_MS = 10_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding an exclusive first-run lock next to prefs.json, so two
 * processes starting at once cannot each mint a different id. Returns
 * undefined if the lock cannot be had in time.
 */
function withInitLock(fn) {
  const lock = `${prefsPath()}.init.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + INIT_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > INIT_LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) return undefined;
    sleepSync(20);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Return this install's id, creating and persisting one on first use. A
 * missing, malformed or unreadable value is replaced. Creation is serialized
 * across processes and re-checked inside the lock, so concurrent first runs
 * agree on one id. If the file cannot be written (or the lock is stuck) the id
 * is still returned for this run; it will simply not persist.
 */
export function getOrCreateInstallId() {
  const existing = readPrefs()?.installId;
  if (isValidInstallId(existing)) return existing;
  const id = withInitLock(() => {
    const current = readPrefs()?.installId;
    if (isValidInstallId(current)) return current;
    const fresh = crypto.randomUUID().toLowerCase();
    savePrefs({}, { installId: fresh });
    return fresh;
  });
  if (isValidInstallId(id)) return id;
  const onDisk = readPrefs()?.installId;
  return isValidInstallId(onDisk) ? onDisk : crypto.randomUUID().toLowerCase();
}

/** sha256 hex of the prefixed raw identifier. The input never leaves this function. */
export function hashAccount(raw) {
  return crypto.createHash('sha256').update(`${ACCOUNT_HASH_PREFIX}${raw}`, 'utf8').digest('hex');
}

/** The OpenRouter API key available locally, or null. Never an account id. */
function rawApiKey(env) {
  const v = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  return v && v.length <= 1024 ? v : null;
}

/**
 * The identity half of the attribution object: `{ install_id, account_hash? }`,
 * or `{}` when disabled. Never throws.
 */
export function attributionIdentity(env = process.env) {
  if (attributionDisabled(env)) return {};
  const out = {};
  try {
    const id = getOrCreateInstallId();
    if (isValidInstallId(id)) out.install_id = id;
  } catch {
    // Attribution is a convenience; a broken home directory must not stop a payment.
  }
  const raw = rawApiKey(env);
  if (raw) out.account_hash = hashAccount(raw);
  return out;
}
