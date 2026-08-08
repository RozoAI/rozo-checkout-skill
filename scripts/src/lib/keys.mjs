/**
 * Hot-wallet key handling (PLAN §5.3).
 *
 *  - Keys come from the environment ONLY: ROZO_CHECKOUT_EVM_KEY /
 *    ROZO_CHECKOUT_SOL_KEY. Never from argv, never from a file this code reads.
 *  - Keys are never printed, never logged, never included in any output object.
 *  - If a `.env` file in the working directory is tracked by git, we refuse to
 *    run at all: a tracked .env means secrets are one `git push` from public.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SkillError } from './output.mjs';

export const EVM_KEY_ENV = 'ROZO_CHECKOUT_EVM_KEY';
export const SOL_KEY_ENV = 'ROZO_CHECKOUT_SOL_KEY';

/** Read a key from env, or throw a message that never echoes the value. */
export function readKey(envName) {
  const v = process.env[envName];
  if (!v || !String(v).trim()) {
    throw new SkillError(
      'MISSING_KEY',
      `${envName} is not set. Export it in the shell that runs this script; ` +
        'the script never accepts a key on the command line.',
    );
  }
  return String(v).trim();
}

/**
 * Refuse to run when a `.env` in the repo working directory is git-tracked.
 * A missing git binary or a non-repo directory is not an error — there is
 * nothing to leak into.
 */
export function assertNoTrackedDotEnv(cwd = process.cwd()) {
  const envFile = path.join(cwd, '.env');
  if (!fs.existsSync(envFile)) return { checked: true, tracked: false };
  let out = '';
  try {
    out = execFileSync('git', ['ls-files', '--error-unmatch', '--', '.env'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    return { checked: true, tracked: false };
  }
  if (out.trim()) {
    throw new SkillError(
      'TRACKED_DOTENV',
      'A `.env` file in this directory is tracked by git. Refusing to use hot-wallet keys ' +
        'here — untrack it (git rm --cached .env) and add it to .gitignore first.',
    );
  }
  return { checked: true, tracked: false };
}

/** Scrub a key-shaped string from any value before it can reach stdout. */
export function forget(obj) {
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (/key|secret|mnemonic|seed/i.test(k)) delete obj[k];
    }
  }
  return obj;
}
