/**
 * Optional distribution-channel label (`utm_source`), so a channel that ships
 * this CLI can tag the orders it creates. Reporting only: no identity, no
 * privilege. Pure: shared by the argument parser and the API layer.
 *
 * Normalized to [a-z0-9._-], at most 100 chars (the router's cap). Anything
 * else returns null and is simply not sent; it can never fail an order.
 */
export function normalizeUtmSource(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 100 || !/^[a-z0-9._-]+$/.test(s)) return null;
  return s;
}
