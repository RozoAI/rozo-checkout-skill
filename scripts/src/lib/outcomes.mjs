/**
 * Broadcast outcome classification, shared by both send scripts.
 *
 * The distinction that matters: a transaction that LANDED AND FAILED is not
 * the same as one we simply never heard back about. The first is a definite
 * failure and must exit non-zero; the second is genuinely unresolved and exits
 * 3 so automation knows money may be in flight. Collapsing them is how a
 * reverted transfer gets read as success.
 */

import { EXIT_OK, EXIT_ERROR, EXIT_UNCONFIRMED } from './output.mjs';

/**
 * @param {object} input
 * @param {"success"|"reverted"|"failed"|null|undefined} input.receiptStatus
 *        EVM receipt status, or null when no receipt arrived.
 * @param {*} [input.executionError] Solana `value.err`, when the tx landed and failed.
 * @param {boolean} [input.receiptSeen] whether any receipt/confirmation arrived.
 * @returns {{state:string, success:boolean, exitCode:number, code:string|null,
 *            recordStatus:string}}
 */
export function broadcastOutcome({ receiptStatus, executionError = null, receiptSeen = undefined }) {
  const seen = receiptSeen ?? (receiptStatus !== null && receiptStatus !== undefined);

  if (executionError) {
    return {
      state: 'failed',
      success: false,
      exitCode: EXIT_ERROR,
      code: 'TX_FAILED',
      recordStatus: 'failed',
    };
  }
  if (!seen) {
    // Never heard back. Money may be in flight — this is NOT a failure, and it
    // is NOT a success.
    return {
      state: 'unconfirmed',
      success: true,
      exitCode: EXIT_UNCONFIRMED,
      code: null,
      recordStatus: 'submitted',
    };
  }
  if (receiptStatus === 'success') {
    return {
      state: 'confirmed',
      success: true,
      exitCode: EXIT_OK,
      code: null,
      recordStatus: 'confirmed',
    };
  }
  return {
    state: 'reverted',
    success: false,
    exitCode: EXIT_ERROR,
    code: 'TX_REVERTED',
    recordStatus: 'failed',
  };
}
