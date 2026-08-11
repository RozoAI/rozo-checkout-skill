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
import crypto from 'node:crypto';
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
  // GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE select a repository without any
  // .git entry in the ancestors — a setup `git ls-files` honoured but this
  // reader does not resolve (env-relative work-tree mapping, alternate index
  // files). Rather than reimplement git's environment handling, refuse: an
  // unresolvable "which repository?" is an unverifiable tracked status.
  for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    if (process.env[v]) {
      throw new SkillError(
        'TRACKED_DOTENV_UNVERIFIABLE',
        `${v} is set, so the repository layout cannot be resolved by reading the filesystem ` +
          'alone. Unset it (or run from a plain checkout) before using hot-wallet keys.',
      );
    }
  }
  let cur = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch (err) {
      // Only a definitely-absent .git continues the upward search. A .git we
      // cannot stat (EACCES, EIO) leaves "is this a repository?" unanswered,
      // and unanswered must refuse — signing would otherwise proceed with the
      // tracked-secret check silently skipped.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw new SkillError(
          'TRACKED_DOTENV_UNVERIFIABLE',
          `A .git entry here could not be inspected (${err?.code || 'error'}), so tracked ` +
            'status cannot be proved. Refusing.',
        );
      }
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
 * (repo-root-relative, POSIX separators). Supports index versions 2 and 3,
 * for both SHA-1 and SHA-256 repositories (`hashLen` 20 or 32).
 *
 * Fail closed, never guess:
 *  - version 4 (path prefix compression) throws;
 *  - the trailing checksum is verified before any parsed path is trusted;
 *  - a `link` extension (core.splitIndex) throws — most tracked paths then
 *    live in sharedindex.* which this parser does not resolve;
 *  - any other mandatory (lowercase) extension throws for the same reason.
 */
export function trackedPathsFromIndex(buf, { hashLen = 20 } = {}) {
  const fail = (why) =>
    new SkillError(
      'TRACKED_DOTENV_UNVERIFIABLE',
      `The git index could not be interpreted (${why}), so tracked status cannot be proved. Refusing.`,
    );
  if (buf.length < 12 + hashLen || buf.toString('latin1', 0, 4) !== 'DIRC') throw fail('bad header');

  // Integrity first: git writes hash(all preceding bytes) as the trailer. A
  // header that parses but a trailer that does not match is corruption, and a
  // corrupt index must refuse — flipped bytes in a pathname would otherwise
  // read as "not tracked".
  const algo = hashLen === 32 ? 'sha256' : 'sha1';
  const expected = buf.subarray(buf.length - hashLen);
  const actual = crypto.createHash(algo).update(buf.subarray(0, buf.length - hashLen)).digest();
  if (!actual.equals(expected)) throw fail(`${algo} checksum mismatch`);

  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw fail(`unsupported index version ${version}`);
  const count = buf.readUInt32BE(8);
  const paths = new Set();
  // Fixed part of an entry: 40 bytes of stat data, the object id, 2 flag bytes.
  const fixed = 40 + hashLen + 2;
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = off;
    if (off + fixed > buf.length - hashLen) throw fail('truncated entry');
    const flags = buf.readUInt16BE(off + fixed - 2);
    let nameOff = off + fixed;
    // v3: an extended-flags word follows when the extended bit is set.
    if (flags & 0x4000) {
      if (version < 3) throw fail('extended flags in v2 index');
      nameOff += 2;
    }
    const nameLen = flags & 0x0fff;
    let end;
    if (nameLen < 0x0fff) {
      end = nameOff + nameLen;
      if (end > buf.length - hashLen) throw fail('truncated path');
    } else {
      end = buf.indexOf(0, nameOff);
      if (end === -1 || end > buf.length - hashLen) throw fail('unterminated path');
    }
    paths.add(buf.toString('utf8', nameOff, end));
    // Entries are NUL-padded so the TOTAL length is a multiple of 8.
    const entryLen = end - entryStart;
    off = entryStart + (Math.floor(entryLen / 8) + 1) * 8;
  }

  // Extensions follow the entries. Optional ones (name starts uppercase, e.g.
  // TREE) are safely skippable; mandatory ones (lowercase, e.g. `link` for
  // core.splitIndex) change what "the tracked set" means, so refuse.
  while (off < buf.length - hashLen) {
    if (off + 8 > buf.length - hashLen) throw fail('truncated extension header');
    const extName = buf.toString('latin1', off, off + 4);
    const extSize = buf.readUInt32BE(off + 4);
    const first = extName.charCodeAt(0);
    if (first >= 0x61 && first <= 0x7a) {
      throw fail(`mandatory index extension "${extName}" (e.g. core.splitIndex) is not supported`);
    }
    off += 8 + extSize;
    if (off > buf.length - hashLen) throw fail('truncated extension');
  }

  return paths;
}

/**
 * The repository's object-id length: 32 for `--object-format=sha256`, else 20.
 * Read from the repo config; an unreadable config on a repo that has one is
 * left to the checksum verification to catch (a wrong hashLen cannot produce
 * a matching checksum).
 */
function repoHashLen(gitDir) {
  // In a linked worktree, gitDir is <common>/worktrees/<name> and the config
  // holding extensions.objectFormat lives in the COMMON directory, named by
  // the `commondir` file. Resolve it first or a SHA-256 worktree would be
  // read as SHA-1 and every valid checksum would be rejected.
  let configDir = gitDir;
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (common) configDir = path.resolve(gitDir, common);
  } catch {
    // No commondir file: this IS the common directory.
  }
  try {
    const cfg = fs.readFileSync(path.join(configDir, 'config'), 'utf8');
    if (/^\s*objectformat\s*=\s*sha256\s*$/im.test(cfg)) return 32;
  } catch {
    // No readable config: assume SHA-1; a mismatch fails the checksum check.
  }
  return 20;
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
  const tracked = trackedPathsFromIndex(buf, { hashLen: repoHashLen(repo.gitDir) });
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
