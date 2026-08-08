/**
 * Stdout/exit conventions, shared by every script:
 *
 *   - exactly ONE JSON object on stdout
 *   - exit 0 = success, 1 = runtime error / refused, 2 = usage error,
 *     3 = submitted but not confirmed within the poll window
 *
 * Every error carries a machine-readable `code` so the agent can branch on the
 * PLAN §3 abort conditions instead of pattern-matching prose.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNCONFIRMED = 3;

/**
 * Redact anything that could be credential material before it reaches stdout.
 *
 * Two classes of secret end up in provider errors:
 *
 *  1. Key material — 0x-prefixed 32-byte hex (EVM private keys, and
 *     unavoidably tx hashes that appear inside error strings), bare 64-char
 *     hex, base58 blobs long enough to be a Solana secret key, and JSON byte
 *     arrays.
 *  2. Credential-bearing URLs — RPC providers routinely put the API key in the
 *     URL path (`/v2/<key>`) or query string, and viem/web3 quote the failing
 *     URL verbatim in their error messages. Any URL is therefore reduced to
 *     `scheme://host/<redacted>`: enough to see which provider failed, never
 *     enough to reuse the endpoint. Bearer tokens and `key=`-style parameters
 *     are stripped wherever else they appear.
 */
export function redact(text) {
  if (text === null || text === undefined) return text;
  let s = typeof text === 'string' ? text : String(text);

  // Key material.
  s = s.replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted>');
  s = s.replace(/\b[0-9a-fA-F]{64}\b/g, '<redacted>');
  s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, '<redacted>');
  s = s.replace(/\[(?:\s*\d{1,3}\s*,){40,}\s*\d{1,3}\s*\]/g, '[<redacted>]');

  // Credential-bearing URLs: keep the host, drop userinfo, path and query.
  s = s.replace(/\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s"'<>]+)/g, (_m, scheme, rest) => {
    const withoutUserinfo = rest.includes('@') ? rest.slice(rest.indexOf('@') + 1) : rest;
    const host = withoutUserinfo.split(/[/?#]/)[0];
    const hadMore = withoutUserinfo.length > host.length;
    return `${scheme}://${host}${hadMore ? '/<redacted>' : ''}`;
  });

  // Bearer / token / key parameters anywhere else in the message.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>');
  s = s.replace(
    /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|secret|token|password|passwd|pwd)\b(\s*[:=]\s*)("?)[A-Za-z0-9._~+/=-]{6,}\3/gi,
    '$1$2<redacted>',
  );

  return s;
}

/** Deep-redact an arbitrary value destined for stdout. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/priv(ate)?[-_]?key|secret|mnemonic|seed/i.test(k)) {
        out[k] = '<redacted>';
        continue;
      }
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Capture mode.
 *
 * Each script's flow signals completion by calling emit()/fail(), which
 * normally writes to stdout and exits the process. The CLI needs to run those
 * same flows back to back inside one process — so under capture() the same
 * calls throw an EmitSignal carrying the payload instead of exiting.
 *
 * This exists so the CLI can reuse the audited flows verbatim. It must never
 * be used to skip one: capture changes only how a result is delivered, never
 * which checks ran.
 */
let capturing = false;

export class EmitSignal extends Error {
  constructor(payload, exitCode) {
    super('emit');
    this.payload = payload;
    this.exitCode = exitCode;
  }
}

/** Build the failure payload shared by fail() and capture(). */
export function formatFailure(err, fallbackCode = 'RUNTIME_ERROR') {
  const code = (err && err.code) || fallbackCode;
  const message = redact((err && err.message) || String(err));
  const payload = { success: false, error: { code, message } };
  if (err && err.details) payload.error.details = redactDeep(err.details);
  return payload;
}

/**
 * Run a flow and return { payload, exitCode } instead of exiting.
 * Any error the flow throws is formatted exactly as fail() would have.
 */
export async function capture(fn) {
  const previous = capturing;
  capturing = true;
  try {
    await fn();
    return {
      payload: formatFailure(
        { code: 'NO_RESULT', message: 'The flow finished without producing a result.' },
      ),
      exitCode: EXIT_ERROR,
    };
  } catch (err) {
    if (err instanceof EmitSignal) return { payload: err.payload, exitCode: err.exitCode };
    return { payload: formatFailure(err), exitCode: EXIT_ERROR };
  } finally {
    capturing = previous;
  }
}

/** Print one JSON object and exit. */
export function emit(payload, exitCode = EXIT_OK) {
  const redacted = redactDeep(payload);
  if (capturing) throw new EmitSignal(redacted, exitCode);
  process.stdout.write(JSON.stringify(redacted, null, 2) + '\n');
  process.exit(exitCode);
}

/** Print a structured failure and exit. */
export function fail(err, fallbackCode = 'RUNTIME_ERROR', exitCode = EXIT_ERROR) {
  const payload = formatFailure(err, fallbackCode);
  if (capturing) throw new EmitSignal(payload, exitCode);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(exitCode);
}

/** Usage error helper. */
export function usage(message) {
  fail({ code: 'USAGE', message }, 'USAGE', EXIT_USAGE);
}

/** Tiny argv parser: --key value / --flag. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** An abortable, coded error. */
export class SkillError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}
