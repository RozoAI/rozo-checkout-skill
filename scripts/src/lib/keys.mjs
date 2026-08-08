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
 * Refuse to run when any `.env` file in the working directory is git-tracked.
 *
 * Fails CLOSED. If a candidate file exists but we cannot determine its tracked
 * status — git missing, git erroring, an unreadable index — we refuse, because
 * "we could not check" is exactly the condition under which a tracked key file
 * would slip through. A directory that is not a git repository at all is fine:
 * there is no repository to leak into.
 *
 * Covers `.env` and every `.env.*` variant (`.env.local`, `.env.e2e-*`, ...),
 * excluding the deliberately public `.env.example` / `.env.sample`.
 */
const ENV_FILE_RE = /^\.env(\..+)?$/;
const PUBLIC_ENV_RE = /^\.env\.(example|sample|template)$/;

export function assertNoTrackedDotEnv(cwd = process.cwd()) {
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(cwd)
      .filter((f) => ENV_FILE_RE.test(f) && !PUBLIC_ENV_RE.test(f));
  } catch (err) {
    // We cannot even list the directory, so we cannot rule out a tracked key
    // file living in it. "Could not check" is not "safe".
    throw new SkillError(
      'TRACKED_DOTENV_UNVERIFIABLE',
      `Could not list this directory (${err?.code || 'unknown error'}), so it cannot be proved ` +
        'that no tracked .env file is present. Refusing to use hot-wallet keys here.',
    );
  }
  if (candidates.length === 0) return { checked: true, tracked: false, candidates: [] };

  // Is this a git repository at all?
  let insideRepo;
  try {
    insideRepo =
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }).trim() === 'true';
  } catch (err) {
    // The ONLY interpretable failure is git telling us this is not a
    // repository — a definite answer, not an error we cannot read. Everything
    // else (git missing, permission denied, a corrupt or unreadable repo, an
    // unrecognised message) leaves the question open, and therefore refuses.
    const stderr = String(err?.stderr || '');
    const notARepo = /not a git repository|does not appear to be a git repository/i.test(stderr);
    if (notARepo) return { checked: true, tracked: false, candidates };
    throw new SkillError(
      'TRACKED_DOTENV_UNVERIFIABLE',
      `Found ${candidates.length} .env file(s) here, but git could not be consulted ` +
        `(${err?.code || 'unknown error'}), so it cannot be proved they are untracked. ` +
        'Refusing to use hot-wallet keys in this directory.',
    );
  }
  if (!insideRepo) return { checked: true, tracked: false, candidates };

  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', ...candidates], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch {
    throw new SkillError(
      'TRACKED_DOTENV_UNVERIFIABLE',
      'git could not report whether the .env file(s) in this directory are tracked. Refusing ' +
        'to use hot-wallet keys rather than assuming they are safe.',
    );
  }

  const tracked = out.split('\0').filter(Boolean);
  if (tracked.length) {
    throw new SkillError(
      'TRACKED_DOTENV',
      `These env file(s) are tracked by git: ${tracked.join(', ')}. Refusing to use hot-wallet ` +
        'keys here — untrack them (git rm --cached <file>) and gitignore them first.',
    );
  }
  return { checked: true, tracked: false, candidates };
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
