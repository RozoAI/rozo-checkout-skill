/**
 * Local preference memory: the last wallet address and coin the user chose.
 *
 * Scope is deliberately tiny. This file holds an address, a preset name, a
 * timestamp and the anonymous install id (see identity.mjs) — never a key,
 * never a balance, never anything about an invoice.
 * It exists only so a repeat payer can press Enter twice instead of retyping.
 *
 * A saved address is re-validated (format and blacklist) on every reuse, so an
 * address that becomes compromised after being saved cannot quietly flow
 * through later runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeAtomic, stateRoot } from './state.mjs';

export function prefsPath() {
  // Sibling of state/, under the same ~/.rozo-checkout root.
  const root = process.env.ROZO_CHECKOUT_STATE_DIR
    ? path.dirname(stateRoot())
    : path.join(os.homedir(), '.rozo-checkout');
  return path.join(root, 'prefs.json');
}

/** Fields we are willing to persist. Anything else is dropped on write. */
const ALLOWED = ['lastPayerAddress', 'lastAddressFamily', 'lastPreset', 'installId', 'updatedAt'];

/** Same pattern the router validates install_id with; anything else is dropped there. */
export const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding an exclusive lock beside prefs.json. Every read-modify-write
 * of the file goes through here, so a coin/address save in one process can
 * never clobber the install id another process just wrote, or vice versa.
 * Returns undefined if the lock cannot be had in time (a stale lock older than
 * LOCK_STALE_MS is reclaimed).
 */
function withPrefsLock(fn) {
  const lock = `${prefsPath()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) return undefined;
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Fields a normal savePrefs() caller may set. installId is set only by identity.mjs. */
const USER_FIELDS = ['lastPayerAddress', 'lastAddressFamily', 'lastPreset'];

/**
 * Read saved preferences. A missing, unreadable, malformed or unexpected file
 * yields null — a broken prefs file must degrade to "no defaults", never crash
 * a payment run.
 */
export function readPrefs() {
  let raw;
  try {
    raw = fs.readFileSync(prefsPath(), 'utf8');
  } catch {
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;

  const out = {};
  for (const k of ALLOWED) {
    const v = doc[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Save preferences, merging over whatever is already there, under the prefs
 * lock with a re-read inside it. Only the allowed fields are written; anything
 * else the caller passes is ignored. `installIdIfAbsent` (identity.mjs only)
 * sets the install id only when the file has no valid one, so the winner of a
 * first-run race is what every process ends up with. Returns the saved
 * document, or null if it could not be saved.
 */
export function savePrefs(update, { installIdIfAbsent } = {}) {
  try {
    const saved = withPrefsLock(() => {
      const existing = readPrefs() || {};
      const next = { ...existing };
      for (const k of USER_FIELDS) {
        const v = update?.[k];
        if (typeof v === 'string' && v.trim()) next[k] = v.trim();
      }
      if (!INSTALL_ID_RE.test(String(existing.installId ?? '')) && INSTALL_ID_RE.test(String(installIdIfAbsent ?? ''))) {
        next.installId = installIdIfAbsent;
      }
      next.updatedAt = new Date().toISOString();
      writeAtomic(prefsPath(), next);
      return next;
    });
    return saved ?? null;
  } catch {
    // Preferences are a convenience. Failing to save one must never fail a
    // payment that has already happened.
    return null;
  }
}

/** Forget everything. Used by --fresh only for the current run, not on disk. */
export function clearPrefs() {
  try {
    fs.unlinkSync(prefsPath());
    return true;
  } catch {
    return false;
  }
}
