/**
 * Identifier taxonomy (PLAN §2). Three IDs, never conflated:
 *   linkId        — Coinbase id: `pl_*` (Payment Link) or `paymentSession_*` (v3)
 *   rozoPaymentId — Rozo intent UUID, used for GET payments/<id>
 *   paymentLink   — Rozo hosted pay page URL (human fallback)
 */

export class IdError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Charsets match what the backend accepts: payment-session ids may contain
// `_` and `-` (base64url-ish), payment-link ids are alphanumeric.
const PL_RE = /(pl_[0-9a-zA-Z]+)/;
const SESSION_RE = /(paymentSession_[A-Za-z0-9_-]+)/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Extract a Coinbase linkId from a URL or a raw id.
 * @returns {{linkId:string, kind:"payment_link"|"payment_session"}}
 */
export function extractLinkId(urlOrId) {
  if (typeof urlOrId !== 'string' || !urlOrId.trim()) {
    throw new IdError('BAD_LINK', 'A Coinbase payment link URL or id is required.');
  }
  const s = urlOrId.trim();
  const session = s.match(SESSION_RE);
  if (session) return { linkId: session[1], kind: 'payment_session' };
  const link = s.match(PL_RE);
  if (link) return { linkId: link[1], kind: 'payment_link' };
  if (/commerce\.coinbase\.com\/pay\//.test(s)) {
    throw new IdError(
      'LEGACY_COMMERCE_URL',
      'commerce.coinbase.com/pay/<uuid> uses the legacy protocol; this skill does not handle it.',
    );
  }
  throw new IdError(
    'BAD_LINK',
    'Could not find a `pl_*` or `paymentSession_*` id in the supplied value.',
  );
}

/** Validate a Rozo intent id (UUID). */
export function assertRozoPaymentId(value) {
  const s = String(value || '').trim();
  if (!UUID_RE.test(s)) {
    throw new IdError('BAD_ROZO_PAYMENT_ID', 'rozoPaymentId must be a UUID.');
  }
  return s;
}

export function isRozoPaymentId(value) {
  return UUID_RE.test(String(value || '').trim());
}

/**
 * Mask an address for prose output: first 6 + last 4.
 * The full address is only ever emitted inside the machine-readable `deposit`
 * JSON block (PLAN §5.5).
 */
export function maskAddress(address) {
  const s = String(address ?? '').trim();
  if (!s) return '(none)';
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/** Mask a memo/tag the same way (memos can be sensitive routing data). */
export function maskMemo(memo) {
  const s = String(memo ?? '').trim();
  if (!s) return null;
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}...${s.slice(-3)}`;
}
