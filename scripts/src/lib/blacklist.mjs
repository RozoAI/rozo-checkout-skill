/**
 * Compromised-address blacklist (PLAN §5.1).
 *
 * Rules encoded here:
 *  - FAIL CLOSED. A missing, unreadable, malformed, empty, or digest-mismatched
 *    blacklist file means we refuse to send. Never "continue without checking".
 *  - Checked for BOTH the destination (deposit address returned by the backend)
 *    and the Mode B sender address.
 *  - Normalized per chain family before comparison: EVM lowercased,
 *    Solana / Stellar / Tron compared verbatim (they are case-sensitive).
 *  - A blacklist pass is NOT destination authentication. The caller must
 *    separately prove the deposit address came from the live payments/<id> GET
 *    of the same run.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class BlacklistError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Normalize an address for comparison, by chain family. */
export function normalizeAddress(address, family) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (family === 'evm' || /^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  // Solana (base58), Stellar (base32) and Tron (base58) are case-sensitive.
  return trimmed;
}

/**
 * Validate a parsed blacklist document. Pure — tests feed it malformed input.
 * Returns { entries, index: Map<normalized, entry>, provenance }.
 * Throws BlacklistError with code BLACKLIST_UNAVAILABLE on any defect.
 */
export function parseBlacklist(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Blacklist document is not an object.');
  }
  const { provenance, entries } = doc;
  if (!provenance || typeof provenance !== 'object') {
    throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Blacklist provenance header is missing.');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Blacklist is empty or not an array.');
  }
  const addresses = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.address !== 'string' || !e.address.trim()) {
      throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Blacklist entry has no address.');
    }
    addresses.push(e.address);
  }
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(addresses), 'utf8')
    .digest('hex');
  if (typeof provenance.addressesSha256 !== 'string' || !provenance.addressesSha256) {
    throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Blacklist provenance digest is missing.');
  }
  if (digest !== provenance.addressesSha256) {
    throw new BlacklistError(
      'BLACKLIST_UNAVAILABLE',
      'Blacklist digest mismatch — the vendored address list was modified without re-signing.',
    );
  }
  if (provenance.addressCount !== undefined && provenance.addressCount !== entries.length) {
    throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Blacklist addressCount does not match entries.');
  }

  const index = new Map();
  for (const e of entries) {
    const key = normalizeAddress(e.address, e.family);
    if (key) index.set(key, e);
    // Also index the EVM lowercase form regardless of declared family, so a
    // mis-tagged entry still catches.
    const lower = e.address.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(lower)) index.set(lower, e);
  }
  return { entries, index, provenance, digest };
}

/** Candidate locations for the vendored file (bundled dist first). */
function candidatePaths(moduleUrl) {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.join(here, 'blacklist.json'),
    path.join(here, '..', 'src', 'lib', 'blacklist.json'),
    path.join(here, '..', '..', 'src', 'lib', 'blacklist.json'),
  ];
}

let cached = null;

/** Load and validate the vendored blacklist. Throws BLACKLIST_UNAVAILABLE. */
export function loadBlacklist(explicitPath) {
  if (!explicitPath && cached) return cached;
  const paths = explicitPath ? [explicitPath] : candidatePaths(import.meta.url);
  let lastErr = null;
  for (const p of paths) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      lastErr = err;
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new BlacklistError('BLACKLIST_UNAVAILABLE', `Blacklist file is not valid JSON: ${p}`);
    }
    const parsed = parseBlacklist(doc);
    parsed.sourceFile = p;
    if (!explicitPath) cached = parsed;
    return parsed;
  }
  throw new BlacklistError(
    'BLACKLIST_UNAVAILABLE',
    `Blacklist file not found (looked in ${paths.length} locations). Refusing to proceed.` +
      (lastErr ? ` Last error: ${lastErr.code || lastErr.message}` : ''),
  );
}

/**
 * Check one address. Returns { hit: boolean, entry|null, normalized }.
 * Callers translate a hit into BLACKLIST_HIT and a load failure into
 * BLACKLIST_UNAVAILABLE; both abort.
 */
export function checkAddress(address, family, blacklist) {
  const bl = blacklist || loadBlacklist();
  const normalized = normalizeAddress(address, family);
  if (!normalized) {
    throw new BlacklistError('BLACKLIST_UNAVAILABLE', 'Cannot check an empty address.');
  }
  const entry = bl.index.get(normalized) || bl.index.get(normalized.toLowerCase()) || null;
  return { hit: Boolean(entry), entry, normalized };
}

/**
 * Check several (address, family, role) tuples at once. Throws on the first
 * hit so no caller can accidentally continue past one.
 */
export function assertNotBlacklisted(targets, blacklist) {
  const bl = blacklist || loadBlacklist();
  for (const t of targets) {
    if (!t || !t.address) continue;
    const { hit, entry } = checkAddress(t.address, t.family, bl);
    if (hit) {
      const err = new BlacklistError(
        'BLACKLIST_HIT',
        `${t.role || 'address'} is on the compromised-wallet blacklist ` +
          `(reported ${entry.reportedOn}: ${entry.note}). Refusing.`,
      );
      err.role = t.role || 'address';
      throw err;
    }
  }
  return true;
}
