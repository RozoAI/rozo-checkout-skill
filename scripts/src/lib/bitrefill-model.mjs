/**
 * Which of the two router models a Bitrefill order was created under.
 * No imports, so guards.mjs and bitrefill.mjs can both use it.
 *
 *   direct  the Rozo payout pays the Bitrefill invoice address itself, for the
 *           invoice amount, no service fee (production until mpprouter #315).
 *   funder  (founder 2026-11-11, mpprouter #315) the order lives under
 *           merchant_openrouter like the OpenRouter line: the payout goes to
 *           the Rozo funder for invoice + 1% service fee, and the funder then
 *           pays the invoice amount to the Bitrefill address. The invoice facts
 *           the funder pays from are frozen in metadata.bitrefill.
 */

/** Rozo's Base USDC funder (rozo-mpprouter bitrefill-binding.ts BITREFILL_FUNDER). */
export const BITREFILL_FUNDER = '0x2352Fa2970dBadD12d21808DB0F56CDEC8141739';

/** The only service fee rate a funder-model Bitrefill order may carry (100 = 1%). */
export const BITREFILL_FEE_BPS = 100;

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/**
 * True when ANY funder-model marker is on the live order. Fail closed: one
 * marker is enough to demand every funder-model check, so a half-written
 * order can never be treated as the simpler direct model.
 */
export function isBitrefillFunderOrder(payment) {
  if (!payment || typeof payment !== 'object') return false;
  const meta = payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : {};
  if (meta.bitrefill !== undefined && meta.bitrefill !== null) return true;
  if (['serviceFee', 'feeBps', 'callerPays', 'original'].some((k) => present(meta[k]))) return true;
  const dest = payment.destination || {};
  const receiver = String(dest.receiverAddress ?? dest.address ?? '').trim().toLowerCase();
  if (receiver && receiver === BITREFILL_FUNDER.toLowerCase()) return true;
  const appId = String(payment.appId ?? payment.app_id ?? '');
  return appId === 'merchant_openrouter';
}
