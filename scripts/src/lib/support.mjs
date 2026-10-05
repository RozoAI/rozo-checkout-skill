/**
 * How a payer reaches ROZO, and the optional contact email that lets ROZO
 * reach the payer.
 *
 * Orders from this CLI are created on a keyless route, so without an email
 * ROZO has no way to contact someone whose order needs attention. The email
 * is optional everywhere: never required, never prompted for by the CLI
 * itself, and validated so a typo is caught before any order exists.
 */

// No import from output.mjs: output.mjs imports SUPPORT from here (to keep
// these public links intact through redaction), so this module stays a leaf.

export const SUPPORT = Object.freeze({
  email: 'hi@rozo.ai',
  x: 'https://x.com/ROZOai',
  discord: 'https://discord.gg/EfWejgTbuU',
});

export const SUPPORT_TEXT =
  `Need help? Email ${SUPPORT.email}, or reach ROZO on X ${SUPPORT.x} ` +
  `or Discord ${SUPPORT.discord}.`;

export const CONTACT_EMAIL_MAX_LENGTH = 254;

// Deliberately simple: one @, non-empty local part, a dotted domain, no
// whitespace or control characters (the router enforces the same shape).
// Stricter on one point: the address must start with a letter or digit. The
// CLI forwards it to the order flows as an argv element, and their parser
// treats a leading "--" as a flag (same reason as the --utm-source rule).
const EMAIL_RE = /^[a-z0-9][^\s@]*@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Normalize an optional contact email.
 * Returns the trimmed, lowercased address, or null when absent/blank.
 * Returns undefined when the value is present but invalid.
 */
export function normalizeContactEmail(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().toLowerCase();
  if (email.length === 0) return null;
  if (email.length > CONTACT_EMAIL_MAX_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(email) || !EMAIL_RE.test(email)) return undefined;
  return email;
}

/**
 * Whether a contact email actually went out with a NEW order. A reused or
 * resumed order keeps whatever email it was first created with (the router
 * never rebinds), so reporting true there would be a false promise.
 */
export function contactEmailAttached(email, reused) {
  return Boolean(email) && !reused;
}

/** "alice@example.com" -> "a***@example.com", for anything printed. */
export function maskEmail(email) {
  const at = String(email).lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Read `--email` for the standalone scripts. Same rule as the CLI: absent or
 * blank means no email; anything present but invalid is a coded error raised
 * before any order is created.
 */
export function contactEmailFromArgs(args) {
  if (args.email === undefined) return null;
  const email = args.email === true ? undefined : normalizeContactEmail(String(args.email));
  if (email === undefined) {
    // Same shape as SkillError (formatFailure reads .code and .message).
    const err = new Error(
      '--email must be a valid email address, for example name@example.com. It is optional: leave it out to continue without one.',
    );
    err.code = 'INVALID_EMAIL';
    throw err;
  }
  return email;
}
