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

import { readPrefs, savePrefs, INSTALL_ID_RE } from './prefs.mjs';

export { INSTALL_ID_RE };

export const ACCOUNT_HASH_PREFIX = 'rozo-acct-v1:';

export const ACCOUNT_HASH_RE = /^[0-9a-f]{64}$/;

export function isValidInstallId(value) {
  return typeof value === 'string' && INSTALL_ID_RE.test(value);
}

/** True when the user switched anonymous attribution off. */
export function attributionDisabled(env = process.env) {
  const v = String(env.ROZO_CHECKOUT_ANON_ID ?? '').trim().toLowerCase();
  return ['off', '0', 'false', 'no'].includes(v);
}

/**
 * Return this install's id, creating and persisting one on first use. A
 * missing or malformed value is replaced. The set-if-absent happens inside
 * savePrefs' cross-process lock with a re-read, so concurrent first runs (and
 * concurrent preference writes) agree on one id. If the file cannot be written
 * or the lock is stuck, an id is still returned for this run; it simply does
 * not persist.
 */
export function getOrCreateInstallId() {
  const existing = readPrefs()?.installId;
  if (isValidInstallId(existing)) return existing;
  const saved = savePrefs({}, { installIdIfAbsent: crypto.randomUUID().toLowerCase() });
  if (isValidInstallId(saved?.installId)) return saved.installId;
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
