/**
 * receipt.js — one read-only look at an order, answered with strict
 * settlement semantics.
 *
 *   node scripts/dist/receipt.js --rozo-payment-id <uuid> [--provider bitrefill]
 *   node scripts/dist/receipt.js --link-id <pl_* | paymentSession_*>
 *
 * Same views and classifier as status.js (no order is created, nothing is
 * sent). The difference is the answer: a three-layer receipt (source payment,
 * merchant settlement, service delivery) and an exit code that means
 * "settled", not "the query worked".
 *
 * Exit codes: 0 settled, 1 definitely not paid or needs a human,
 * 2 usage, 3 not finished yet or state unknown.
 */

import { parseArgs, emit, usage } from './lib/output.mjs';
import { isRozoPaymentId } from './lib/ids.mjs';
import { SUPPORT } from './lib/support.mjs';
import { snapshot } from './status.mjs';
import { buildReceipt, receiptExitCode } from './lib/receipt.mjs';

async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = args['rozo-payment-id'] || (isRozoPaymentId(args._[0]) ? args._[0] : null);
  const linkId = args['link-id'] || (!rozoPaymentId ? args._[0] : null);
  const provider = args.provider ? String(args.provider) : null;
  if (provider && provider !== 'bitrefill' && provider !== 'coinbase') {
    usage('--provider must be coinbase or bitrefill');
  }
  if (provider === 'bitrefill' && !rozoPaymentId) {
    usage('A Bitrefill order is tracked by --rozo-payment-id <uuid>.');
  }
  if (!rozoPaymentId && !linkId) {
    usage('Required: --rozo-payment-id <uuid> and/or --link-id <pl_* | paymentSession_*>');
  }

  const result = await snapshot({ rozoPaymentId, linkId, provider });
  const receipt = buildReceipt(result);
  const exitCode = receiptExitCode(receipt.paymentOutcome);

  emit(
    {
      success: receipt.paymentOutcome === 'settled',
      operationOk: !result.unknown,
      step: 'receipt',
      receipt,
      errors: result.errors,
      ...(exitCode === 0 ? {} : { support: SUPPORT }),
    },
    exitCode,
  );
}

/** Entry point for the standalone script and the CLI (see status.mjs). */
export async function run(argv = process.argv.slice(2)) {
  return main(argv);
}
