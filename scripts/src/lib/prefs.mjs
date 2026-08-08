/**
 * Local preference memory: the last wallet address and coin the user chose.
 *
 * Scope is deliberately tiny. This file holds an address, a preset name and a
 * timestamp — never a key, never a balance, never anything about an invoice.
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
const ALLOWED = ['lastPayerAddress', 'lastAddressFamily', 'lastPreset', 'updatedAt'];

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
 * Save preferences, merging over whatever is already there. Only the allowed
 * fields are written; anything else the caller passes is ignored.
 */
export function savePrefs(update) {
  const existing = readPrefs() || {};
  const next = { ...existing };
  for (const k of ALLOWED) {
    if (k === 'updatedAt') continue;
    const v = update?.[k];
    if (typeof v === 'string' && v.trim()) next[k] = v.trim();
  }
  next.updatedAt = new Date().toISOString();
  try {
    writeAtomic(prefsPath(), next);
  } catch {
    // Preferences are a convenience. Failing to save one must never fail a
    // payment that has already happened.
    return null;
  }
  return next;
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
