/**
 * Stdout/exit conventions, shared by every script (same shape as the sibling
 * internal payment skills payment scripts):
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
 * Redact anything that could be key material before it reaches stdout.
 * Covers 0x-prefixed 32-byte hex (EVM private keys — and, unavoidably, tx
 * hashes that appear inside error strings), bare 64-char hex, and base58
 * blobs long enough to be a Solana secret key.
 */
export function redact(text) {
  if (text === null || text === undefined) return text;
  let s = typeof text === 'string' ? text : String(text);
  s = s.replace(/0x[0-9a-fA-F]{64}/g, '0x<redacted>');
  s = s.replace(/\b[0-9a-fA-F]{64}\b/g, '<redacted>');
  s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, '<redacted>');
  // Defensive: JSON-ish secret key arrays.
  s = s.replace(/\[(?:\s*\d{1,3}\s*,){40,}\s*\d{1,3}\s*\]/g, '[<redacted>]');
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

/** Print one JSON object and exit. */
export function emit(payload, exitCode = EXIT_OK) {
  process.stdout.write(JSON.stringify(redactDeep(payload), null, 2) + '\n');
  process.exit(exitCode);
}

/** Print a structured failure and exit. */
export function fail(err, fallbackCode = 'RUNTIME_ERROR', exitCode = EXIT_ERROR) {
  const code = (err && err.code) || fallbackCode;
  const message = redact((err && err.message) || String(err));
  const payload = {
    success: false,
    error: { code, message },
  };
  if (err && err.details) payload.error.details = redactDeep(err.details);
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
