/**
 * ROZO Agent Checkout (beta, off by default): an agent binds itself to an
 * owner, then asks that owner to approve a payment. The agent never pays and
 * never sees a pay link, an approval nonce or a balance; the owner approves in
 * Discord.
 *
 * Everything here is gated on ROZO_AGENT_CHECKOUT_BETA=1. With the gate off
 * the commands print one line and make no network call at all.
 *
 * Router contract (mpprouter, /v1/agent-checkout):
 *   POST /bind-requests/claim   unauthenticated, the bind code is the secret
 *   GET  /binding               Authorization: Bearer <credential>
 *   POST /requests              Authorization + Idempotency-Key
 *   GET  /requests/<id>         Authorization
 *
 * The credential (ac_live_… / ac_test_…) is written once to
 * ~/.rozo-checkout/agent-checkout-credential (0600, dir 0700) and is never
 * printed, logged or passed on a command line.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { SkillError, redact } from './output.mjs';
import { stateRoot, writeAtomic } from './state.mjs';
import { USER_AGENT, redactUrl, parseRetryAfter } from './http.mjs';
import { ATTRIBUTION_CLIENT } from './api.mjs';
import { CliError } from './cli-args.mjs';
import { extractLinkId } from './ids.mjs';

export const GATE_ENV = 'ROZO_AGENT_CHECKOUT_BETA';
export const BASE_ENV = 'ROZO_CHECKOUT_AC_BASE';
export const DEFAULT_BASE = 'https://apiserver.mpprouter.dev/v1/agent-checkout';
export const NOT_AVAILABLE = 'Agent Checkout is not available yet.';

export const AC_COMMANDS = ['bind', 'binding-status', 'request', 'request-status'];

export const CREDENTIAL_RE = /^ac_(live|test)_[A-Za-z0-9_-]{43}$/;
export const BIND_CODE_RE = /^acbind_(live|test)_[A-Za-z0-9_-]{22}$/;
export const FINGERPRINT_RE = /^ac_[0-9a-f]{12}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const SPEND_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const API_TIMEOUT_MS = 20_000;
export const CONTEXT_MAX = 2000;
export const DISPLAY_NAME_MAX = 64;
export const DEFAULT_DISPLAY_NAME = 'rozo-checkout CLI';

export function gateOn(env = process.env) {
  return env[GATE_ENV] === '1';
}

const TRUSTED_ORIGIN = 'https://apiserver.mpprouter.dev';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The router base URL. The stored Bearer credential and the bind code are only
 * ever sent to the trusted https origin, or to a loopback host (tests and
 * local development). Anything else is refused before a secret is read.
 */
export function acBase(env = process.env) {
  const raw = String(env[BASE_ENV] || DEFAULT_BASE).replace(/\/+$/, '');
  let u;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  const trusted =
    u &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    ((u.protocol === 'https:' && u.origin === TRUSTED_ORIGIN) ||
      ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)));
  if (!trusted) {
    throw new SkillError(
      'AC_BASE_UNTRUSTED',
      `${BASE_ENV} must be ${TRUSTED_ORIGIN}/… (or a loopback host for testing). Nothing was read or sent.`,
    );
  }
  return raw;
}

/** Upstream error codes are shown only when they look like a code. */
export const UPSTREAM_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const DISPLAY_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** True when argv names one of the agent checkout commands. */
export function isAgentCheckoutArgv(argv) {
  const first = argv.find((a) => !a.startsWith('-'));
  return AC_COMMANDS.includes(first);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const BOOLEAN = new Set(['json', 'force', 'help']);
const VALUE = new Set(['name', 'context', 'funding', 'idempotency-key']);
const ALLOWED = {
  bind: new Set(['json', 'force', 'help', 'name']),
  'binding-status': new Set(['json', 'help']),
  request: new Set(['json', 'help', 'context', 'funding', 'idempotency-key']),
  'request-status': new Set(['json', 'help']),
};

export const AC_HELP = `AGENT CHECKOUT (beta; ${GATE_ENV}=1)
  An agent asks its owner to approve a payment. Nothing is paid until the
  owner approves in Discord.

  rozo-checkout bind [<bindCode> | -] [--name <displayName>] [--force]
      Bind this agent to an owner with the code from the Discord settings page.
      Pass - (or nothing) to read the code from stdin. The credential is saved
      to ~/.rozo-checkout/agent-checkout-credential (mode 0600) and never shown.
  rozo-checkout binding-status
  rozo-checkout request <coinbase link> --context "<why>" [--funding auto|per_payment]
                        [--idempotency-key <key>]
      Ask the owner to approve paying a Coinbase payment link. Rerun the same
      command to retry; it reuses the same idempotency key.
  rozo-checkout request-status <spendRequestId>
  Add --json for machine-readable output.`;

export function parseAgentCheckoutArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (BOOLEAN.has(key)) {
        flags[key] = value === undefined ? true : value !== 'false';
        continue;
      }
      if (VALUE.has(key)) {
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || value.startsWith('--')) {
            throw new CliError('MISSING_VALUE', `--${key} needs a value.`);
          }
          i++;
        }
        flags[key] = value;
        continue;
      }
      throw new CliError('UNKNOWN_FLAG', `Unknown flag --${key}.`);
    }
    positional.push(a);
  }
  const command = positional.shift();
  if (!AC_COMMANDS.includes(command)) {
    throw new CliError('UNKNOWN_COMMAND', `Expected one of: ${AC_COMMANDS.join(', ')}.`);
  }
  for (const k of Object.keys(flags)) {
    if (!ALLOWED[command].has(k)) throw new CliError('UNKNOWN_FLAG', `--${k} does not apply to ${command}.`);
  }
  const opts = { command, json: Boolean(flags.json), help: Boolean(flags.help) };
  if (opts.help) return opts;

  if (command === 'bind') {
    if (positional.length > 1) throw new CliError('USAGE', 'bind takes one bind code.');
    opts.bindCodeArg = positional[0] ?? null;
    opts.force = Boolean(flags.force);
    opts.displayName = validateDisplayName(flags.name ?? DEFAULT_DISPLAY_NAME);
  } else if (command === 'binding-status') {
    if (positional.length) throw new CliError('USAGE', 'binding-status takes no arguments.');
  } else if (command === 'request') {
    if (positional.length !== 1) throw new CliError('USAGE', 'request needs exactly one Coinbase payment link.');
    opts.invoice = parseInvoice(positional[0]);
    opts.context = validateContext(flags.context);
    if (flags.funding !== undefined) {
      if (!['auto', 'per_payment'].includes(flags.funding)) {
        throw new CliError('BAD_FUNDING', '--funding must be auto or per_payment.');
      }
      opts.fundingPreference = flags.funding;
    }
    if (flags['idempotency-key'] !== undefined) {
      if (!IDEMPOTENCY_KEY_RE.test(flags['idempotency-key'])) {
        throw new CliError('BAD_IDEMPOTENCY_KEY', 'Idempotency key must be 8 to 128 of A-Z a-z 0-9 _ . : -');
      }
      opts.idempotencyKey = flags['idempotency-key'];
    }
  } else if (command === 'request-status') {
    if (positional.length !== 1 || !SPEND_REQUEST_ID_RE.test(positional[0])) {
      throw new CliError('USAGE', 'request-status needs one spendRequestId.');
    }
    opts.spendRequestId = positional[0];
  }
  return opts;
}

export function validateDisplayName(name) {
  const s = String(name ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(s)) {
    throw new CliError('BAD_NAME', `--name must be 1 to ${DISPLAY_NAME_MAX} printable characters.`);
  }
  return s;
}

export function validateContext(context) {
  const s = typeof context === 'string' ? context.trim() : '';
  if (!s) throw new CliError('CONTEXT_REQUIRED', '--context "<why you want to pay>" is required; your owner reads it.');
  if (s.length > CONTEXT_MAX) throw new CliError('CONTEXT_TOO_LONG', `--context is limited to ${CONTEXT_MAX} characters.`);
  return s;
}

/** Coinbase payment links only (for now). Returns { url, invoiceId }. */
export function parseInvoice(value) {
  let linkId;
  try {
    ({ linkId } = extractLinkId(value));
  } catch (err) {
    throw new CliError('INVOICE_UNSUPPORTED', 'request supports Coinbase payment links only (pl_* or paymentSession_*).');
  }
  const s = String(value).trim();
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new CliError('INVOICE_UNSUPPORTED', 'That is not a valid Coinbase payment link URL.');
    }
    if (u.protocol !== 'https:' || u.hostname !== 'payments.coinbase.com') {
      throw new CliError('INVOICE_UNSUPPORTED', 'request supports payments.coinbase.com links only.');
    }
  }
  const kind = linkId.startsWith('pl_') ? 'payment-links' : 'payment-sessions';
  return { url: `https://payments.coinbase.com/${kind}/${linkId}`, invoiceId: linkId };
}

export function validateBindCode(code) {
  const s = String(code ?? '').trim();
  if (!BIND_CODE_RE.test(s)) {
    throw new SkillError('BIND_CODE_INVALID', 'That does not look like a bind code (acbind_live_…). Copy it again from the Discord settings page.');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Credential file
// ---------------------------------------------------------------------------

export function credentialDir(env = process.env) {
  return env.ROZO_CHECKOUT_STATE_DIR ? path.dirname(stateRoot()) : path.join(os.homedir(), '.rozo-checkout');
}

export function credentialPath(env = process.env) {
  return path.join(credentialDir(env), 'agent-checkout-credential');
}

/** ac_live_…WXYZ. Never more than the prefix and the last 4. */
export function maskCredential(credential) {
  const m = String(credential ?? '').match(/^(ac_(?:live|test)_)/);
  const s = String(credential ?? '');
  if (!m || s.length < m[1].length + 8) return '<redacted>';
  return `${m[1]}…${s.slice(-4)}`;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const st = fs.statSync(dir);
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
}

export function credentialExists(env = process.env) {
  try {
    fs.lstatSync(credentialPath(env));
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare the credential write BEFORE the single-use bind code is claimed:
 * the private dir is created and checked, and an exclusive 0600 temp file is
 * opened, so a claim never succeeds into a credential that cannot be saved.
 * commit() writes, fsyncs and links (no overwrite) or renames (--force);
 * abort() removes the temp file.
 */
export function prepareCredentialWrite({ force = false, env = process.env } = {}) {
  const file = credentialPath(env);
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077) !== 0) {
    throw new SkillError('CREDENTIAL_DIR_PERMISSIONS', `${dir} is not private (0700); nothing was claimed.`);
  }
  if (!force && credentialExists(env)) {
    throw new SkillError('CREDENTIAL_EXISTS', `A credential already exists at ${file}. Pass --force to replace it.`);
  }
  const tmp = path.join(dir, `.agent-checkout-credential.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = fs.openSync(tmp, 'wx', 0o600);
  const cleanup = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
  };
  return {
    file,
    abort: cleanup,
    commit(record) {
      try {
        if (!CREDENTIAL_RE.test(record?.credential || '')) {
          throw new SkillError('CREDENTIAL_INVALID', 'The router returned a credential in an unexpected format; nothing was saved.');
        }
        fs.writeFileSync(fd, `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        if (force) fs.renameSync(tmp, file);
        else fs.linkSync(tmp, file); // fails with EEXIST, never replaces
      } catch (err) {
        cleanup();
        if (err?.code === 'EEXIST') {
          throw new SkillError('CREDENTIAL_EXISTS', `A credential already exists at ${file}. Pass --force to replace it.`);
        }
        throw err;
      }
      cleanup(); // removes the temp name left behind by link()
      return file;
    },
  };
}

/** Prepare and commit in one go (used where no network call sits between). */
export function saveCredential(record, opts = {}) {
  const w = prepareCredentialWrite(opts);
  return w.commit(record);
}

/** Read and validate the stored credential. Refuses a file readable by others. */
export function readCredential(env = process.env) {
  const file = credentialPath(env);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new SkillError('NOT_BOUND', 'This agent is not bound yet. Run: rozo-checkout bind');
  }
  if (!st.isFile()) {
    throw new SkillError('CREDENTIAL_FILE_INVALID', `${file} is not a regular file; refusing to read it.`);
  }
  if (process.platform !== 'win32') {
    if ((st.mode & 0o077) !== 0) {
      throw new SkillError(
        'CREDENTIAL_FILE_PERMISSIONS',
        `${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 ${file}. Nothing was sent.`,
      );
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new SkillError('CREDENTIAL_FILE_PERMISSIONS', `${file} is owned by another user; refusing to use it.`);
    }
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new SkillError('CREDENTIAL_FILE_INVALID', `${file} is not a valid credential file. Bind again with --force.`);
  }
  if (!rec || typeof rec !== 'object' || !CREDENTIAL_RE.test(rec.credential || '')) {
    throw new SkillError('CREDENTIAL_FILE_INVALID', `${file} does not hold a valid credential. Bind again with --force.`);
  }
  if (rec.fingerprint !== undefined && rec.fingerprint !== null && !FINGERPRINT_RE.test(rec.fingerprint)) {
    throw new SkillError('CREDENTIAL_FILE_INVALID', `${file} has a malformed fingerprint. Bind again with --force.`);
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Idempotency keys, one per invoice (and binding), so a rerun is a replay
// ---------------------------------------------------------------------------

function idempotencyFile(invoiceId, env = process.env) {
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(invoiceId)) {
    throw new SkillError('BAD_LINK', 'Refusing to build a state path from that invoice id.');
  }
  return path.join(stateRoot(), 'agent-checkout', `${invoiceId}.json`);
}

export function readIdempotencyRecord(invoiceId, env = process.env) {
  try {
    const rec = JSON.parse(fs.readFileSync(idempotencyFile(invoiceId, env), 'utf8'));
    if (rec && IDEMPOTENCY_KEY_RE.test(rec.idempotencyKey || '')) return rec;
  } catch {
    // absent or unreadable: a fresh key is made
  }
  return null;
}

export function writeIdempotencyRecord(invoiceId, record, env = process.env) {
  writeAtomic(idempotencyFile(invoiceId, env), { invoiceId, ...record });
}

/**
 * Create the per-invoice record only if none exists (temp file + link, so a
 * reader never sees a half-written file). Returns the record that won: ours,
 * or the one a concurrent run saved first.
 */
export function claimIdempotencyRecord(invoiceId, record, env = process.env) {
  const file = idempotencyFile(invoiceId, env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const full = { invoiceId, ...record };
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return { record: full, won: true };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const existing = readIdempotencyRecord(invoiceId, env);
    if (existing) return { record: existing, won: false };
    throw new SkillError('STATE_UNREADABLE', `Could not read ${file}; remove it or pass --idempotency-key.`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

/**
 * The key to send: an explicit one wins; else the saved one for this invoice
 * and binding; else a new one, claimed atomically before the request goes out
 * so concurrent runs for the same invoice all use the same key.
 */
export function resolveIdempotencyKey({ invoiceId, explicit, fingerprint, env = process.env }) {
  const fp = fingerprint ?? null;
  const saved = readIdempotencyRecord(invoiceId, env);
  const fresh = (key) => ({ idempotencyKey: key, fingerprint: fp, createdAt: new Date().toISOString() });
  if (explicit) {
    if (!saved || saved.idempotencyKey !== explicit) writeIdempotencyRecord(invoiceId, fresh(explicit), env);
    return { key: explicit, reused: Boolean(saved && saved.idempotencyKey === explicit), generated: false };
  }
  if (saved && (saved.fingerprint ?? null) === fp) {
    return { key: saved.idempotencyKey, reused: true, generated: false };
  }
  const key = `cli_${crypto.randomUUID()}`;
  if (saved) {
    // A record from another binding: replace it (a new binding is a new request).
    writeIdempotencyRecord(invoiceId, fresh(key), env);
    return { key, reused: false, generated: true };
  }
  const { record, won } = claimIdempotencyRecord(invoiceId, fresh(key), env);
  return { key: record.idempotencyKey, reused: !won, generated: won };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Plain messages for the router's error codes. Every code a caller can act on
 * is listed; anything else passes through with its HTTP status.
 */
export const ERROR_MESSAGES = {
  UNAUTHORIZED:
    'The router did not accept this agent credential: your owner has not confirmed the binding in Discord yet, or it was revoked. Run binding-status, or bind again with a new code.',
  NOT_FOUND:
    'Not found: no such spend request for this agent, or Agent Checkout is not switched on at the router yet.',
  IDEMPOTENCY_CONFLICT:
    'This idempotency key was already used for a different request (another --context or --funding). Rerun with the original details, or pass a new --idempotency-key.',
  INVOICE_IN_PROGRESS: 'A spend request for this invoice is already in progress.',
  AC_DISABLED: 'Agent Checkout is switched off right now. Nothing was requested and nothing was paid.',
  AC_NOT_CONFIGURED: 'Agent Checkout is not configured at the router yet. Nothing was requested and nothing was paid.',
  AC_UNAVAILABLE: 'Agent Checkout is temporarily unavailable. Nothing was paid; try again later.',
  RETRY_LATER: 'The router asked to retry later. Rerun the same command; it reuses the same idempotency key.',
  RATE_LIMITED: 'Rate limited. Wait and rerun the same command.',
  BIND_CODE_INVALID: 'The bind code was not accepted: wrong, expired or already used. Get a new one from the Discord settings page.',
  INVOICE_UNSUPPORTED: 'This invoice is not supported. Agent Checkout takes Coinbase payment links only for now.',
  INVOICE_EXPIRING: 'This invoice expires too soon to ask your owner. Get a fresh payment link.',
  CONTEXT_REQUIRED: 'A --context is required.',
  OWNER_NOT_ALLOWED: 'Your owner is not allowed to use Agent Checkout yet.',
  LINE_ITEMS_MISMATCH: 'Line items do not match the invoice.',
  INVALID_INPUT: 'The router rejected the input.',
};

export async function acApi(method, apiPath, { body, credential, idempotencyKey, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const url = `${acBase(env)}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        'x-rozo-client': ATTRIBUTION_CLIENT,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    text = await res.text();
  } catch (err) {
    throw new SkillError(
      err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE',
      `${method} ${apiPath} failed: ${redact(err?.message || String(err))}`,
      { url: redactUrl(url) },
    );
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) {
    if (json === null || typeof json !== 'object') {
      throw new SkillError('HTTP_BAD_JSON', 'Agent Checkout returned a non-JSON body.', { httpStatus: res.status });
    }
    return { status: res.status, json };
  }
  const rawCode =
    (typeof json?.error?.code === 'string' && json.error.code) ||
    (typeof json?.code === 'string' && json.code) ||
    (typeof json?.error === 'string' && json.error) ||
    null;
  // Only a code-shaped value is shown; anything else (which could carry a
  // secret echoed by a broken upstream) becomes UPSTREAM_ERROR.
  const code = rawCode === null ? `HTTP_${res.status}` : UPSTREAM_CODE_RE.test(rawCode) ? rawCode : 'UPSTREAM_ERROR';
  const details = { httpStatus: res.status };
  const retryMs = parseRetryAfter(res.headers?.get?.('retry-after'));
  if (retryMs !== null) details.retryAfterSeconds = Math.ceil(retryMs / 1000);
  if (code === 'INVOICE_IN_PROGRESS') {
    const id = json?.error?.spendRequestId ?? json?.spendRequestId;
    const ref = json?.error?.displayRef ?? json?.displayRef;
    if (typeof id === 'string' && SPEND_REQUEST_ID_RE.test(id)) details.spendRequestId = id;
    if (typeof ref === 'string' && DISPLAY_REF_RE.test(ref)) details.displayRef = ref;
  }
  throw new SkillError(code, ERROR_MESSAGES[code] || `Agent Checkout returned HTTP ${res.status}.`, details);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export const STATUS_TEXT = {
  created: 'Created; the quote is not ready yet. Rerun the same request command later.',
  pending_approval: 'Waiting for your owner to approve in Discord. Nothing has been paid.',
  approved: 'Approved by your owner; payment has not started yet.',
  awaiting_payment: 'Approved; waiting for the owner to pay on the payment page.',
  paying: 'Payment in progress.',
  succeeded: 'Paid.',
  denied: 'Your owner denied this request. Nothing was paid.',
  expired: 'Expired before it was approved and paid. Nothing was paid.',
  canceled: 'Canceled. Nothing was paid.',
  failed: 'Failed. Ask your owner to check Discord.',
  manual_review: 'Held for manual review by Rozo.',
};

export const BINDING_TEXT = {
  pending_confirm: 'Waiting for your owner to confirm this agent in Discord.',
  active: 'Active: this agent can ask its owner to approve payments.',
  revoked: 'Revoked by the owner. Bind again with a new code.',
  rejected: 'Rejected by the owner. Bind again with a new code.',
};

/** USDC atomic (6 decimals) string to a decimal string, or null. */
export function formatUsdcAtomic(atomic) {
  if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) return null;
  const s = atomic.padStart(7, '0');
  const whole = s.slice(0, -6).replace(/^0+(?=\d)/, '');
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac.padEnd(2, '0')}` : `${whole}.00`;
}

/** The agent view, reduced to known fields (no pass-through of anything new). */
export function summarizeRequest(r) {
  if (!r || typeof r !== 'object') return null;
  const pick = (k) => (r[k] === undefined ? null : r[k]);
  return {
    spendRequestId: pick('spendRequestId'),
    displayRef: pick('displayRef'),
    status: pick('status'),
    statusReason: pick('statusReason'),
    environment: pick('environment'),
    provider: pick('provider'),
    invoiceId: pick('invoiceId'),
    merchantDisplay: pick('merchantDisplay'),
    merchantVerified: pick('merchantVerified'),
    invoiceAmount: pick('invoiceAmount'),
    invoiceCurrency: pick('invoiceCurrency'),
    feeUsdc: formatUsdcAtomic(r.feeAtomic),
    totalDebitUsdc: formatUsdcAtomic(r.totalDebitAtomic),
    fundingMode: pick('fundingMode'),
    approvalExpiresAt: pick('approvalExpiresAt'),
    quoteExpiresAt: pick('quoteExpiresAt'),
    merchantPaymentStatus: pick('merchantPaymentStatus'),
    merchantDeliveryStatus: pick('merchantDeliveryStatus'),
    createdAt: pick('createdAt'),
    updatedAt: pick('updatedAt'),
    statusText: STATUS_TEXT[r.status] ?? null,
  };
}
