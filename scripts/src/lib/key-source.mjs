/**
 * Where the Mode B signing key comes from.
 *
 * This layer decides WHICH key signs. It changes nothing about WHAT gets
 * signed: preflight, the confirmation digest, the blacklist (sender and
 * destination), the $1,100 limit, claimSend and the payability recheck all run
 * exactly as before, on whatever signer this returns.
 *
 * Precedence, first hit wins:
 *   1. --keyfile <path>                     explicit, either family
 *   2. Solana: ~/.config/solana/id.json     the standard solana-keygen keypair
 *      EVM:    ROZO_CHECKOUT_EVM_KEYSTORE   encrypted V3 (geth/web3) keystore
 *   3. ROZO_CHECKOUT_EVM_KEY / ROZO_CHECKOUT_SOL_KEY   raw key in the
 *      environment — still supported, and the right choice for unattended
 *      automation where no one can type a passphrase.
 *
 * Nothing here prints a path's contents, a passphrase, or decrypted material.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { keccak256 } from 'viem';

import { SkillError } from './output.mjs';
import { assertNotTrackedByGit } from './keys.mjs';

export const EVM_KEY_ENV = 'ROZO_CHECKOUT_EVM_KEY';
export const SOL_KEY_ENV = 'ROZO_CHECKOUT_SOL_KEY';
export const EVM_KEYSTORE_ENV = 'ROZO_CHECKOUT_EVM_KEYSTORE';
export const KEYSTORE_PASSPHRASE_ENV = 'ROZO_CHECKOUT_KEYSTORE_PASSPHRASE';

/** The path solana-keygen writes by default. */
export function defaultSolanaKeypairPath() {
  return path.join(os.homedir(), '.config', 'solana', 'id.json');
}

/**
 * A key file must not be readable by anyone else, and must not be tracked by
 * git. Both checks fail closed.
 */
export function assertKeyfileSafe(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new SkillError(
      'KEYFILE_UNREADABLE',
      `Cannot read key file (${err.code || 'unknown error'}). Check the path.`,
    );
  }
  if (!stat.isFile()) {
    throw new SkillError('KEYFILE_UNREADABLE', 'That key file path is not a regular file.');
  }
  // Windows does not model these bits meaningfully; skip there rather than
  // refusing every file.
  if (process.platform !== 'win32' && stat.mode & 0o077) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    throw new SkillError(
      'KEYFILE_PERMISSIONS',
      `That key file is readable by other users (mode ${mode}). Run: chmod 600 ${file}`,
    );
  }
  assertNotTrackedByGit(file);
  return true;
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

/**
 * Parse a solana-keygen keypair file: a JSON array of 64 bytes (secret key) or
 * 32 bytes (seed). Pure — takes text, returns bytes.
 */
export function parseSolanaKeypairJson(text) {
  let arr;
  try {
    arr = JSON.parse(String(text));
  } catch {
    throw new SkillError(
      'BAD_KEYPAIR_FILE',
      'That file is not a Solana keypair: expected a JSON array of bytes.',
    );
  }
  if (!Array.isArray(arr)) {
    throw new SkillError('BAD_KEYPAIR_FILE', 'A Solana keypair file must contain a JSON array.');
  }
  if (arr.length !== 64 && arr.length !== 32) {
    throw new SkillError(
      'BAD_KEYPAIR_FILE',
      `A Solana keypair must be 64 bytes (or a 32-byte seed); this file has ${arr.length}.`,
    );
  }
  for (const b of arr) {
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new SkillError('BAD_KEYPAIR_FILE', 'A Solana keypair must contain byte values 0-255.');
    }
  }
  return Uint8Array.from(arr);
}

/**
 * Normalise an EVM private key to the 0x-prefixed form viem expects.
 *
 * MetaMask and Rabby — the two most common wallets — export 64 hex characters
 * with NO 0x prefix, so requiring the prefix guaranteed a first-run failure for
 * most users. The prefix is optional here; everything else stays strict.
 *
 * Accepts exactly 64 hex characters, with or without a leading 0x/0X.
 * Rejects anything else. The value never appears in an error message.
 */
export function normalizeEvmPrivateKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) {
    throw new SkillError('MISSING_KEY', 'No EVM private key supplied.');
  }
  const body = /^0[xX]/.test(s) ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    // Length is safe to report; the characters are not.
    throw new SkillError(
      'BAD_KEY_FORMAT',
      `An EVM private key must be 64 hex characters, with or without a 0x prefix ` +
        `(got ${body.length} characters after any prefix). Value withheld.`,
    );
  }
  return `0x${body.toLowerCase()}`;
}

/** Decode the value of ROZO_CHECKOUT_SOL_KEY: base58, or a JSON byte array. */
export function decodeSolanaEnvKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new SkillError('MISSING_KEY', `${SOL_KEY_ENV} is empty.`);
  if (s.startsWith('[')) return parseSolanaKeypairJson(s);
  const bytes = base58Decode(s);
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new SkillError(
      'BAD_KEY_FORMAT',
      `${SOL_KEY_ENV} must be a base58 secret key or a JSON byte array.`,
    );
  }
  return bytes;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new SkillError('BAD_KEY_FORMAT', 'Not valid base58.');
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  for (const ch of str) {
    if (ch === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// EVM keystore (V3, geth / web3 secret-storage)
// ---------------------------------------------------------------------------

/**
 * Decrypt a V3 keystore. Supports both KDFs the format defines: scrypt (what
 * geth and most wallets write) and pbkdf2.
 *
 * The MAC is verified before the plaintext is trusted, so a wrong passphrase
 * is reported as a wrong passphrase rather than yielding a garbage key that
 * would derive some unrelated address.
 */
export function decryptKeystoreV3(keystore, passphrase) {
  const ks = typeof keystore === 'string' ? safeParseJson(keystore) : keystore;
  if (!ks || typeof ks !== 'object' || !ks.crypto) {
    throw new SkillError(
      'BAD_KEYSTORE',
      'That file is not a V3 keystore (no "crypto" section). Export an encrypted JSON keystore ' +
        'from your wallet, or use a raw key in the environment.',
    );
  }
  if (ks.version !== undefined && Number(ks.version) !== 3) {
    throw new SkillError('BAD_KEYSTORE', `Unsupported keystore version ${ks.version}; expected 3.`);
  }

  const c = ks.crypto;
  const kdfparams = c.kdfparams || {};
  const pass = Buffer.from(String(passphrase ?? ''), 'utf8');
  let derived;

  if (c.kdf === 'scrypt') {
    const { n, r, p, dklen, salt } = kdfparams;
    if (!n || !r || !p || !dklen || !salt) {
      throw new SkillError('BAD_KEYSTORE', 'The keystore scrypt parameters are incomplete.');
    }
    derived = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), dklen, {
      N: n,
      r,
      p,
      // geth's default N=262144 needs roughly 256 MB; the Node default cap is
      // far lower, so raise it with headroom rather than failing on a normal file.
      maxmem: 256 * n * r + 64 * 1024 * 1024,
    });
  } else if (c.kdf === 'pbkdf2') {
    const { c: iterations, dklen, salt, prf } = kdfparams;
    if (prf && prf !== 'hmac-sha256') {
      throw new SkillError('BAD_KEYSTORE', `Unsupported keystore PRF "${prf}".`);
    }
    if (!iterations || !dklen || !salt) {
      throw new SkillError('BAD_KEYSTORE', 'The keystore pbkdf2 parameters are incomplete.');
    }
    derived = crypto.pbkdf2Sync(pass, Buffer.from(salt, 'hex'), iterations, dklen, 'sha256');
  } else {
    throw new SkillError('BAD_KEYSTORE', `Unsupported keystore KDF "${c.kdf}".`);
  }

  const ciphertext = Buffer.from(c.ciphertext, 'hex');
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);
  if (!timingSafeEqualHex(mac, String(c.mac || ''))) {
    throw new SkillError(
      'KEYSTORE_BAD_PASSPHRASE',
      'Wrong passphrase for that keystore (the MAC did not verify).',
    );
  }

  if (c.cipher !== 'aes-128-ctr') {
    throw new SkillError('BAD_KEYSTORE', `Unsupported keystore cipher "${c.cipher}".`);
  }
  const decipher = crypto.createDecipheriv(
    'aes-128-ctr',
    derived.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, 'hex'),
  );
  const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (secret.length !== 32) {
    throw new SkillError('BAD_KEYSTORE', 'The decrypted key is not 32 bytes.');
  }
  return `0x${secret.toString('hex')}`;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SkillError('BAD_KEYSTORE', 'That keystore file is not valid JSON.');
  }
}

function timingSafeEqualHex(a, b) {
  const ab = Buffer.from(String(a).toLowerCase(), 'hex');
  const bb = Buffer.from(String(b).toLowerCase(), 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Does this file look like a V3 keystore rather than a raw keypair array? */
export function looksLikeKeystore(text) {
  const t = String(text).trimStart();
  if (!t.startsWith('{')) return false;
  try {
    const o = JSON.parse(t);
    return Boolean(o && typeof o === 'object' && o.crypto);
  } catch {
    return false;
  }
}

/**
 * Decide which source to use, without reading any secret yet. Returns
 * { kind, label, path? } so a caller can describe the choice before loading.
 *
 * kind: 'keypair-file' | 'keystore' | 'env'
 */
export function planKeySource({ family, keyfile, env = process.env }) {
  if (keyfile) {
    const resolved = expandHome(keyfile);
    let text;
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      throw new SkillError(
        'KEYFILE_UNREADABLE',
        `Cannot read ${displayPath(resolved)} (${err.code || 'unknown error'}).`,
      );
    }
    const kind = looksLikeKeystore(text) ? 'keystore' : 'keypair-file';
    if (kind === 'keypair-file' && family === 'evm') {
      throw new SkillError(
        'BAD_KEYSTORE',
        'That file is not a V3 keystore. For EVM, --keyfile expects an encrypted JSON keystore.',
      );
    }
    if (kind === 'keystore' && family === 'solana') {
      throw new SkillError(
        'BAD_KEYPAIR_FILE',
        'That looks like an EVM keystore. For Solana, --keyfile expects a solana-keygen ' +
          'keypair file (a JSON array of bytes).',
      );
    }
    return { kind, path: resolved, label: displayPath(resolved) };
  }

  if (family === 'solana') {
    const standard = defaultSolanaKeypairPath();
    if (fs.existsSync(standard)) {
      return { kind: 'keypair-file', path: standard, label: displayPath(standard) };
    }
    if (env[SOL_KEY_ENV]) return { kind: 'env', label: SOL_KEY_ENV };
    throw new SkillError(
      'NO_KEY_SOURCE',
      `No signing key found. Either create one with solana-keygen (writes ` +
        `${displayPath(standard)}), pass --keyfile <path>, or set ${SOL_KEY_ENV}.`,
    );
  }

  if (family === 'evm') {
    const fromEnv = env[EVM_KEYSTORE_ENV];
    if (fromEnv) {
      const resolved = expandHome(fromEnv);
      return { kind: 'keystore', path: resolved, label: displayPath(resolved) };
    }
    if (env[EVM_KEY_ENV]) return { kind: 'env', label: EVM_KEY_ENV };
    throw new SkillError(
      'NO_KEY_SOURCE',
      `No signing key found. Either point ${EVM_KEYSTORE_ENV} at an encrypted JSON keystore, ` +
        `pass --keyfile <path>, or set ${EVM_KEY_ENV}.`,
    );
  }

  throw new SkillError('NO_KEY_SOURCE', `No key source for family "${family}".`);
}

/**
 * Load the actual signing material for a planned source.
 *
 * @param {object} plan       from planKeySource
 * @param {object} opts
 * @param {Function} [opts.askPassphrase] async () => string, used only for a
 *        keystore on a TTY. Never receives or returns anything else.
 * @returns {Promise<{privateKey?:string, secretKey?:Uint8Array, label:string, kind:string}>}
 */
export async function loadKeySource(plan, { family, env = process.env, askPassphrase } = {}) {
  if (plan.kind === 'env') {
    const name = family === 'evm' ? EVM_KEY_ENV : SOL_KEY_ENV;
    const raw = env[name];
    if (!raw || !String(raw).trim()) {
      throw new SkillError('MISSING_KEY', `${name} is not set.`);
    }
    if (family === 'evm') {
      // Accepts the bare 64-hex form that browser wallets export.
      return { privateKey: normalizeEvmPrivateKey(raw), label: plan.label, kind: plan.kind };
    }
    return { secretKey: decodeSolanaEnvKey(raw), label: plan.label, kind: plan.kind };
  }

  assertKeyfileSafe(plan.path);
  const text = fs.readFileSync(plan.path, 'utf8');

  if (plan.kind === 'keypair-file') {
    return { secretKey: parseSolanaKeypairJson(text), label: plan.label, kind: plan.kind };
  }

  // Keystore: passphrase from the environment for unattended runs, otherwise
  // prompted. It is never accepted as a command-line argument.
  let passphrase = env[KEYSTORE_PASSPHRASE_ENV];
  if (passphrase === undefined || passphrase === '') {
    if (!askPassphrase) {
      throw new SkillError(
        'KEYSTORE_PASSPHRASE_REQUIRED',
        `That keystore needs a passphrase. Run this on a terminal to be prompted, or set ` +
          `${KEYSTORE_PASSPHRASE_ENV} for unattended use.`,
      );
    }
    passphrase = await askPassphrase();
  }
  const privateKey = decryptKeystoreV3(text, passphrase);
  return { privateKey, label: plan.label, kind: plan.kind };
}

/**
 * Answer "can this machine sign at all?" before anything is created.
 *
 * The send scripts already call planKeySource, but they call it late — after
 * an order exists and after the CLI has announced "Sending…". A user with no
 * key configured saw a payment tool claim it was sending and then fail, with
 * no way to tell whether money had moved. This is the same question asked
 * first, while the answer is still free.
 *
 * Like planKeySource, this only decides WHICH source would be used. It never
 * reads, decrypts or returns key material; that stays in loadKeySource at
 * signing time.
 *
 * The env handling is the subtle part. A send script applies `--env-file` to
 * process.env itself, so a key living in `.env` is invisible to a check that
 * reads a bare process.env — which would reject a perfectly payable wallet.
 * We therefore apply the dotenv to a COPY: the key is found, and the real
 * environment the send path builds for itself is left untouched.
 *
 * @param {object}  opts
 * @param {string}  opts.family     'evm' | 'solana'
 * @param {string} [opts.keyfile]   --keyfile, if given
 * @param {string} [opts.envFile]   --env-file, if given
 * @param {object} [opts.env]       defaults to process.env; copied, never mutated
 * @param {string} [opts.cwd]       for locating an implicit ./.env
 * @param {Function} [opts.applyEnvFile] injection seam for tests
 * @returns {{kind: string, label: string, path?: string}} the planned source
 * @throws  {SkillError} NO_KEY_SOURCE, KEYFILE_UNREADABLE, BAD_KEYSTORE,
 *          BAD_KEYPAIR_FILE, or any env-file hygiene failure — each carrying
 *          the exact remedy for this chain.
 */
export function planSignability({
  family,
  keyfile,
  envFile,
  env = process.env,
  cwd = process.cwd(),
  applyEnvFile,
}) {
  const probeEnv = { ...env };
  // Surfacing an unreadable / world-readable / git-tracked .env here rather
  // than mid-send is the same trade: fail before an order is expiring.
  if (applyEnvFile) applyEnvFile({ file: envFile, cwd, env: probeEnv });
  return planKeySource({ family, keyfile, env: probeEnv });
}

/** `~/x` in a config value is not expanded by the shell when quoted. */
export function expandHome(p) {
  const s = String(p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Show paths under the home directory as `~/...`, never as an absolute path. */
export function displayPath(p) {
  const home = os.homedir();
  const s = String(p);
  return s.startsWith(home + path.sep) ? `~${s.slice(home.length)}` : s;
}
