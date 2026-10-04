/**
 * Optional distribution-channel label (`utm_source`), so a channel that ships
 * this CLI can tag the orders it creates. Reporting only: no identity, no
 * privilege. Pure: shared by the argument parser and the API layer.
 *
 * Normalized to [a-z0-9._-], at most 100 chars (the router's cap), and it
 * must start with a letter or digit: the CLI hands the value to the order
 * flows as an argv element, so a leading "-" (e.g. "--confirm") would be
 * re-parsed as a control flag. Anything else returns null and is simply not
 * sent; an env value can never fail an order.
 */
export function normalizeUtmSource(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(s)) return null;
  return s;
}
