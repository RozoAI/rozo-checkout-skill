/**
 * Where the x402 agent key lives.
 *
 * The agent key (`ak_…`) is the only credential the x402 payer uses. It owns a
 * prepaid balance at Rozo; it cannot move funds anywhere except to x402
 * sellers within the per-key limits Rozo enforces. Rozo stores only its digest
 * and returns the key once, at creation.
 *
 * Lookup order:
 *   1. ROZO_CHECKOUT_X402_KEY in the environment
 *   2. ~/.rozo-checkout/x402-key (file mode 0600, written by `x402 topup`)
 *
 * The key is never printed in full and never passed on the command line.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stateRoot } from './state.mjs';

export const KEY_ENV = 'ROZO_CHECKOUT_X402_KEY';

export function keyPath() {
  const root = process.env.ROZO_CHECKOUT_STATE_DIR
    ? path.dirname(stateRoot())
    : path.join(os.homedir(), '.rozo-checkout');
  return path.join(root, 'x402-key');
}

/** Returns { key, source } or null. */
export function readAgentKey() {
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' };
  try {
    const text = fs.readFileSync(keyPath(), 'utf8').trim();
    if (text) return { key: text, source: 'file' };
  } catch {
    // absent is normal before the first topup
  }
  return null;
}

/** Persist a newly created key with owner-only permissions. Refuses to overwrite. */
export function saveAgentKey(key) {
  const file = keyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 'wx' fails if the file exists, so an existing key (and its balance) is
  // never silently replaced by a second create.
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${key}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}
