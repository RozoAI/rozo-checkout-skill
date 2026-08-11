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
import { SkillError } from './output.mjs';

// ---------------------------------------------------------------------------
// Git-tracked detection, WITHOUT child_process.
//
// This module used to shell out to `git rev-parse` / `git ls-files`. Those
// were the only subprocess executions in the whole skill, and they made every
// security scan of the published bundle light up with "shell command execution
// detected" — indistinguishable, to a scanner, from a skill that runs
// arbitrary commands. Reading `.git/index` directly answers the same question
// ("does the index contain this path?") with plain file reads, which is also
// exactly what `git ls-files` does under the hood.
//
// The fail-closed contract is unchanged: a definite "no repository" passes,
// a definite "tracked" refuses, and anything unverifiable — an index version
// this parser does not support, a corrupt index, an unreadable directory —
// refuses rather than assumes.
// ---------------------------------------------------------------------------

/**
 * Find the repository containing `dir`: walk up looking for a `.git` entry.
 * Returns { root, gitDir } or null when no repository contains `dir`.
 * A `.git` FILE (worktree / submodule) is followed via its `gitdir:` pointer.
 */
export function findGitRepo(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st) {
      if (st.isDirectory()) return { root: cur, gitDir: dotGit };
      // Worktree/submodule pointer file: "gitdir: <path>\n"
      let text;
      try {
        text = fs.readFileSync(dotGit, 'utf8');
      } catch {
        throw new SkillError(
          'TRACKED_DOTENV_UNVERIFIABLE',
          'A .git entry exists here but could not be read, so tracked status cannot be proved. Refusing.',
        );
      }
      const m = /^gitdir:\s*(.+)\s*$/m.exec(text);
      if (!m) {
        throw new SkillError(
          'TRACKED_DOTENV_UNVERIFIABLE',
          'A .git file exists here but is not a recognised gitdir pointer. Refusing.',
        );
      }
      return { root: cur, gitDir: path.resolve(cur, m[1]) };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Parse a `.git/index` buffer and return the set of tracked paths
 * (repo-root-relative, POSIX separators). Supports index versions 2 and 3.
 * Version 4 (path prefix compression) and anything unrecognised throw —
 * fail closed, never guess.
 */
export function trackedPathsFromIndex(buf) {
  const fail = (why) =>
    new SkillError(
      'TRACKED_DOTENV_UNVERIFIABLE',
      `The git index could not be interpreted (${why}), so tracked status cannot be proved. Refusing.`,
    );
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') throw fail('bad header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw fail(`unsupported index version ${version}`);
  const count = buf.readUInt32BE(8);
  const paths = new Set();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = off;
    if (off + 62 > buf.length) throw fail('truncated entry');
    const flags = buf.readUInt16BE(off + 60);
    let nameOff = off + 62;
    // v3: an extended-flags word follows when the extended bit is set.
    if (flags & 0x4000) {
      if (version < 3) throw fail('extended flags in v2 index');
      nameOff += 2;
    }
    const nameLen = flags & 0x0fff;
    let end;
    if (nameLen < 0x0fff) {
      end = nameOff + nameLen;
      if (end > buf.length) throw fail('truncated path');
    } else {
      end = buf.indexOf(0, nameOff);
      if (end === -1) throw fail('unterminated path');
    }
    paths.add(buf.toString('utf8', nameOff, end));
    // Entries are NUL-padded so the TOTAL length is a multiple of 8.
    const entryLen = end - entryStart;
    off = entryStart + (Math.floor(entryLen / 8) + 1) * 8;
  }
  return paths;
}

/**
 * Which of `files` (absolute paths inside `root`) does the index track?
 * Unverifiable states throw; "no index yet" means nothing is tracked.
 */
function trackedAmong(repo, files) {
  const indexPath = path.join(repo.gitDir, 'index');
  let buf;
  try {
    buf = fs.readFileSync(indexPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return []; // fresh repo, nothing staged or committed
    throw new SkillError(
      'TRACKED_DOTENV_UNVERIFIABLE',
      'The git index exists but could not be read, so tracked status cannot be proved. Refusing.',
    );
  }
  const tracked = trackedPathsFromIndex(buf);
  return files.filter((f) => {
    const rel = path.relative(repo.root, path.resolve(f)).split(path.sep).join('/');
    return tracked.has(rel);
  });
}

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

/**
 * Refuse a secret-bearing file that git tracks. A key file committed to a
 * repository is one `git push` from being public.
 */
export function assertNotTrackedByGit(file) {
  const dir = path.dirname(path.resolve(file));
  const repo = findGitRepo(dir);
  if (!repo) return { checked: true, tracked: false };
  const hits = trackedAmong(repo, [file]);
  if (hits.length) {
    const base = path.basename(file);
    throw new SkillError(
      'TRACKED_KEYFILE',
      `${base} is tracked by git. A committed key is one push from being public — ` +
        `untrack it (git rm --cached ${base}) and gitignore it before using it to sign.`,
    );
  }
  return { checked: true, tracked: false };
}

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

  const repo = findGitRepo(cwd);
  if (!repo) return { checked: true, tracked: false, candidates };

  const tracked = trackedAmong(repo, candidates.map((f) => path.join(cwd, f))).map((f) =>
    path.basename(f),
  );
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
