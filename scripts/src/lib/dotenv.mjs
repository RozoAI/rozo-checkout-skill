/**
 * A deliberately small `.env` reader for the hot-wallet settings.
 *
 * This is NOT a general env injector. It reads a fixed allow-list of keys and
 * ignores everything else in the file, so an unrelated secret sitting in the
 * same `.env` is never pulled into this process.
 *
 * It parses the file ITSELF, with plain string handling. It never invokes a
 * shell: no `source`, no `eval`, no passing contents to a subprocess. A value
 * containing spaces, quotes, semicolons or backticks is just a string here.
 * Shell-evaluating a `.env` has caused a real secret-leak incident before —
 * a multi-token value became a command and its output reached a transcript.
 *
 * Precedence: the real process environment always wins, so an inline
 * `KEY=... npx …` overrides whatever the file says.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillError } from './output.mjs';
import { assertNotTrackedByGit } from './keys.mjs';

/** The only keys read from a .env file. Everything else is ignored. */
export const ALLOWED_KEYS = [
  'ROZO_CHECKOUT_EVM_KEY',
  'ROZO_CHECKOUT_SOL_KEY',
  'ROZO_CHECKOUT_EVM_KEYSTORE',
  'ROZO_CHECKOUT_KEYSTORE_PASSPHRASE',
];

/** RPC overrides are per-chain, so they are matched by pattern. */
export const ALLOWED_PATTERN = /^ROZO_CHECKOUT_RPC_[A-Za-z0-9_]+$/;

export function isAllowedKey(key) {
  return ALLOWED_KEYS.includes(key) || ALLOWED_PATTERN.test(key);
}

/**
 * Parse `.env` text into a plain object. Strict and total.
 *
 * Supported: `KEY=VALUE`, a leading `export `, `#` comments, blank lines,
 * surrounding single or double quotes, CRLF line endings, and values that
 * themselves contain `=`.
 *
 * NOT supported, on purpose: variable interpolation, command substitution,
 * multi-line values, escape sequences. A value is taken literally.
 *
 * Error messages carry the LINE NUMBER only — never the line's content, which
 * would put a secret into an error string.
 */
export function parseDotenv(text) {
  const vars = {};
  const lines = String(text).split(/\r?\n/);

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) {
      throw new SkillError(
        'BAD_ENV_FILE',
        `Malformed .env: line ${lineNo} is not KEY=VALUE. (Content withheld — it may be a secret.)`,
      );
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new SkillError(
        'BAD_ENV_FILE',
        `Malformed .env: line ${lineNo} has an invalid key name. (Content withheld.)`,
      );
    }

    let value = withoutExport.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes; anything inside is literal.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  });

  return vars;
}

/** Keep only the keys this tool is willing to read. */
export function filterAllowed(vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) if (isAllowedKey(k)) out[k] = v;
  return out;
}

/**
 * The places a `.env` is looked for, in order, when `--env-file` is not given.
 *
 * The second entry exists because of how this skill is actually run: every
 * documented command starts by `cd`-ing into the skill's own directory, so the
 * working directory is the skill install — never wherever the user was
 * standing when they wrote their file. Without a user-level location, a `.env`
 * put anywhere sensible was silently out of scope.
 *
 * That location is `~/.rozo-checkout/.env`, this tool's own directory (already
 * home to its state and prefs) — deliberately NOT `~/.env`. A generic home
 * dotenv belongs to the user and typically holds unrelated credentials: API
 * keys, database URLs. Reading it at all would mean parsing secrets that were
 * never offered to us, on every run, just to discover it has nothing of ours
 * in it. Owning the path keeps this tool to files that exist for this tool.
 */
export function envFileCandidates({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const candidates = [path.join(cwd, '.env')];
  const owned = path.join(home, '.rozo-checkout', '.env');
  if (owned !== candidates[0]) candidates.push(owned);
  return candidates;
}

/**
 * Locate the file to read: an explicit path, else the first candidate that
 * exists. Returns null when there is nothing to load.
 */
export function resolveEnvFile({ file, cwd = process.cwd(), home = os.homedir() } = {}) {
  if (file) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) {
      throw new SkillError('ENV_FILE_MISSING', `No such env file: ${file}`);
    }
    return p;
  }
  return envFileCandidates({ cwd, home }).find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Read a `.env` and apply its allowed keys to `process.env`, WITHOUT
 * overwriting anything already set there.
 *
 * Applying to process.env keeps every existing reader working unchanged
 * (`planKeySource`, the per-chain RPC lookup) with no second code path that
 * could disagree about precedence.
 *
 * @returns {{path: string, applied: string[], ignored: number} | null}
 */
export function applyDotenv({
  file,
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
} = {}) {
  const target = resolveEnvFile({ file, cwd, home });
  if (!target) return null;

  // Same hygiene as a key file: not world-readable, not tracked by git.
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    throw new SkillError('ENV_FILE_MISSING', `Cannot read env file (${err.code || 'error'}).`);
  }
  if (process.platform !== 'win32' && stat.mode & 0o077) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    throw new SkillError(
      'ENV_FILE_PERMISSIONS',
      `That .env is readable by other users (mode ${mode}). Run: chmod 600 ${target}`,
    );
  }
  assertNotTrackedByGit(target);

  const parsed = parseDotenv(fs.readFileSync(target, 'utf8'));
  const allowed = filterAllowed(parsed);

  const applied = [];
  for (const [k, v] of Object.entries(allowed)) {
    // The real environment wins; an empty string counts as unset.
    const existing = env[k];
    if (existing !== undefined && String(existing).trim() !== '') continue;
    env[k] = v;
    applied.push(k);
  }

  return {
    path: target,
    applied,
    ignored: Object.keys(parsed).length - Object.keys(allowed).length,
  };
}
