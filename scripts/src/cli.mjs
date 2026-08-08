#!/usr/bin/env node
/**
 * rozo-checkout — the npx-runnable front end.
 *
 * This file is ORCHESTRATION ONLY. Every check that protects money lives in
 * the same flows the standalone scripts use (quote / create-order / status /
 * send-evm / send-sol), which are imported here and run through capture() so
 * their results come back as values instead of exiting the process.
 *
 * Consequences worth stating plainly:
 *   - the CLI cannot skip a gate, because it does not implement any
 *   - --send still goes through preflight, the confirmation record, the
 *     blacklist, the expiry margins, the spend caps and claimSend, unchanged
 *   - the deposit address is still withheld until the confirm phase
 */

// Must precede the Solana imports: it filters their optional-native warning.
import './lib/quiet-deps.mjs';

import readline from 'node:readline';
import { createRequire } from 'node:module';

import { capture, formatFailure, EXIT_OK, EXIT_ERROR, EXIT_USAGE } from './lib/output.mjs';
import { parseCliArgs, CliError, HELP } from './lib/cli-args.mjs';
import { chainFamily, isSatsUnit } from './lib/amounts.mjs';
import { extractLinkId, isRozoPaymentId } from './lib/ids.mjs';

import { run as runQuote } from './quote.mjs';
import { run as runCreateOrder } from './create-order.mjs';
import { run as runStatus } from './status.mjs';
import { run as runSendEvm } from './send-evm.mjs';
import { run as runSendSol } from './send-sol.mjs';

const VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);

const out = (s = '') => process.stdout.write(`${s}\n`);

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printError(payload) {
  const e = payload?.error || {};
  out(`${red('✗')} ${bold(e.code || 'ERROR')}`);
  if (e.message) out(`  ${e.message}`);
  if (payload?.guidance) out(`  ${yellow(payload.guidance)}`);
}

/** Money-detected results must never be shown as an ordinary failure. */
function printMoneyWarning(payload) {
  if (!payload?.moneyDetected) return;
  out();
  out(red(bold('  A payment for this order has already been detected.')));
  out(red('  Do NOT pay again and do NOT create a new order for this link.'));
  out(`  linkId:        ${payload.linkId ?? '(unknown)'}`);
  out(`  rozoPaymentId: ${payload.rozoPaymentId ?? '(unknown)'}`);
  out(red('  Keep those identifiers and have a human reconcile the payment.'));
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

/** Run one of the audited flows and hand back its payload plus exit code. */
async function step(fn, argv) {
  return capture(() => fn(argv));
}

function targetToArgs(target) {
  // `status` accepts either identifier; the flow decides what to do with it.
  if (isRozoPaymentId(target)) return ['--rozo-payment-id', target];
  const { linkId } = extractLinkId(target);
  return ['--link-id', linkId];
}

async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^(y|yes)$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdQuote(opts) {
  const { payload, exitCode } = await step(runQuote, ['--url', opts.target]);
  if (opts.json) {
    printJson(payload);
    return exitCode;
  }
  if (!payload.success) {
    printError(payload);
    return exitCode;
  }
  out();
  out(`  ${bold(payload.merchant ?? 'Unknown merchant')}`);
  out(`  Invoice   ${bold(`${payload.invoice?.amount} ${payload.invoice?.fiat?.currency ?? 'USD'}`)}`);
  out(`  You pay   ${payload.callerPays} ${dim('(no discount on this route)')}`);
  out(`  Expires   ${payload.coinbaseExpiryIso ?? 'unknown'}`);
  out();
  out(dim('  Next: rozo-checkout pay <link> --with usdt-solana'));
  out();
  return exitCode;
}

async function cmdStatus(opts) {
  const argv = [...targetToArgs(opts.target), '--timeout', String(opts.timeout ?? 600)];
  if (opts.watch) argv.push('--watch');
  const { payload, exitCode } = await step(runStatus, argv);
  if (opts.json) {
    printJson(payload);
    return exitCode;
  }
  if (payload.error) {
    printError(payload);
    return exitCode;
  }
  out();
  out(`  State   ${stateLabel(payload.state)}`);
  if (payload.detail) out(`  ${dim(payload.detail)}`);
  if (payload.payin?.txHash) out(`  Pay-in  ${payload.payin.txHash}`);
  if (payload.guidance) out(`  ${payload.escalate ? red(payload.guidance) : dim(payload.guidance)}`);
  printMoneyWarning(payload);
  out();
  return exitCode;
}

function stateLabel(state) {
  if (state === 'settled') return green(bold(state));
  if (['underpaid', 'stuck_after_payment', 'unknown'].includes(state)) return red(bold(state));
  if (state === 'expired_unfunded') return yellow(bold(state));
  return bold(state);
}

async function cmdPay(opts) {
  let sendResult = null;
  const { chainId, tokenSymbol } = opts.source;
  const baseArgs = ['--url', opts.target, '--chain', chainId, '--token', tokenSymbol];

  // --- 1. create the order; the deposit address is withheld at this point ---
  const created = await step(runCreateOrder, baseArgs);
  if (!created.payload.success) {
    if (opts.json) printJson(created.payload);
    else {
      printError(created.payload);
      printMoneyWarning(created.payload);
    }
    return created.exitCode;
  }

  const p = created.payload;
  const rozoPaymentId = p.rozoPaymentId;

  if (!opts.json) {
    out();
    out(`  ${bold(p.merchant ?? 'Unknown merchant')}`);
    out(`  Invoice   ${bold(`${p.invoice?.amount} ${p.invoice?.currency ?? 'USD'}`)}`);
    out(`  You send  ${bold(p.display?.amount)} on ${bold(p.display?.chain)}`);
    out(`  To        ${p.display?.payToMasked} ${dim('(full address shown after you confirm)')}`);
    if (p.display?.hasMemo) out(`  Memo      ${p.display.receiverMemoMasked}`);
    out(`  Expires   ${p.expiry?.effectiveDeadlineIso} ${dim(`(${p.expiry?.minutesOfSlack} min of slack)`)}`);
    if (p.reused) out(`  ${dim('Reused an existing unfunded order for this link.')}`);
    out();
    out(dim(`  The amount you send includes bridge and network fees, so it is`));
    out(dim(`  normally larger than the invoice.`));
    for (const w of p.confirmation?.warnings ?? []) out(dim(`  · ${w}`));
    out();
  }

  // --- 2. binding confirmation -------------------------------------------
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      const payload = formatFailure({
        code: 'CONFIRMATION_REQUIRED',
        message:
          'Not running on a terminal, so the payment cannot be confirmed interactively. ' +
          'Re-run with --yes once you have reviewed the amount and destination.',
      });
      if (opts.json) printJson(payload);
      else printError(payload);
      return EXIT_ERROR;
    }
    const ok = await askYesNo(`  ${bold('Pay this?')} [y/N] `);
    if (!ok) {
      out(dim('  Cancelled. The order was not funded and will simply expire.'));
      out();
      return EXIT_OK;
    }
  }

  // --- 3. confirm phase: releases the full deposit block -------------------
  const confirmed = await step(runCreateOrder, [...baseArgs, '--confirm']);
  if (!confirmed.payload.success) {
    if (opts.json) printJson(confirmed.payload);
    else {
      printError(confirmed.payload);
      printMoneyWarning(confirmed.payload);
    }
    return confirmed.exitCode;
  }
  const deposit = confirmed.payload.deposit;

  // --- 4a. Mode B: hand off to the audited send flow ----------------------
  if (opts.send) {
    const family = chainFamily(deposit.chainId);
    const sender = family === 'evm' ? runSendEvm : family === 'solana' ? runSendSol : null;
    if (!sender) {
      const payload = formatFailure({
        code: 'SEND_UNSUPPORTED_CHAIN',
        message:
          `--send is not available for ${deposit.chain}. Pay the deposit below from your own ` +
          'wallet instead.',
      });
      if (opts.json) printJson(payload);
      else {
        printError(payload);
        printDeposit(deposit, opts);
      }
      return EXIT_ERROR;
    }

    const sendArgs = ['--rozo-payment-id', rozoPaymentId];
    if (opts.dryRun) sendArgs.push('--dry-run');
    else sendArgs.push('--send');
    if (opts.rpc) sendArgs.push('--rpc', opts.rpc);

    if (!opts.json) out(dim(opts.dryRun ? '  Preparing (dry run)…' : '  Sending…'));
    const sent = await step(sender, sendArgs);
    sendResult = sent.payload;
    if (opts.json) {
      if (!sent.payload.success) {
        printJson({ success: false, step: 'pay', order: confirmed.payload, send: sent.payload });
        return sent.exitCode;
      }
    } else if (!sent.payload.success) {
      printError(sent.payload);
      printMoneyWarning(sent.payload);
      return sent.exitCode;
    } else if (opts.dryRun) {
      out(`  ${green('✓')} Dry run only — nothing was signed or broadcast.`);
      out();
      return sent.exitCode;
    } else {
      out(`  ${green('✓')} Sent. tx ${sent.payload.txHash}`);
      out();
    }
    if (sent.exitCode !== EXIT_OK && sent.exitCode !== 3) return sent.exitCode;
  } else if (!opts.json) {
    // --- 4b. Mode A: the user pays from their own wallet ------------------
    printDeposit(deposit, opts);
  }

  if (!opts.watch) {
    if (opts.json) {
      printJson({ success: true, step: 'pay', order: confirmed.payload, send: sendResult });
    }
    return EXIT_OK;
  }

  // --- 5. poll to settlement ---------------------------------------------
  if (!opts.json) out(dim('  Waiting for settlement… (Ctrl-C to stop; the payment continues)'));
  const watched = await step(runStatus, [
    '--rozo-payment-id',
    rozoPaymentId,
    '--watch',
    '--timeout',
    String(opts.timeout),
  ]);
  if (opts.json) {
    printJson({
      success: Boolean(watched.payload?.success),
      step: 'pay',
      order: confirmed.payload,
      send: sendResult,
      status: watched.payload,
    });
    return watched.exitCode;
  }
  out();
  out(`  State   ${stateLabel(watched.payload.state)}`);
  if (watched.payload.detail) out(`  ${dim(watched.payload.detail)}`);
  if (watched.payload.guidance) {
    out(`  ${watched.payload.escalate ? red(watched.payload.guidance) : dim(watched.payload.guidance)}`);
  }
  printMoneyWarning(watched.payload);
  out();
  return watched.exitCode;
}

/** The full address belongs here and only here — it must be copy-pastable. */
function printDeposit(deposit, opts) {
  if (opts.json) return;
  out(`  ${bold('Send exactly:')}`);
  out();
  if (deposit.lnInvoice) {
    out(`    Amount   ${bold(`${deposit.amount} ${isSatsUnit(deposit.amountUnit) ? 'sats' : deposit.tokenSymbol}`)}`);
    out(`    BOLT11   ${deposit.lnInvoice}`);
  } else {
    out(`    Amount   ${bold(`${deposit.amount} ${deposit.tokenSymbol}`)}`);
    out(`    Chain    ${bold(deposit.chain)}`);
    out(`    Address  ${bold(deposit.receiverAddress)}`);
    if (deposit.receiverMemo) out(`    Memo     ${bold(deposit.receiverMemo)} ${red('(required)')}`);
  }
  out();
  out(dim('  Copy the address from this block; do not retype it.'));
  out(dim('  Send it exactly once.'));
  out();
}

// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      const payload = formatFailure(err);
      if (process.argv.includes('--json')) printJson(payload);
      else {
        printError(payload);
        out(dim('\n  rozo-checkout --help for usage.'));
      }
      return EXIT_USAGE;
    }
    throw err;
  }

  switch (opts.command) {
    case 'help':
      if (opts.json) printJson({ success: true, help: HELP, version: VERSION });
      else out(HELP);
      return EXIT_OK;
    case 'version':
      if (opts.json) printJson({ success: true, version: VERSION });
      else out(VERSION);
      return EXIT_OK;
    case 'quote':
      return cmdQuote(opts);
    case 'status':
      return cmdStatus(opts);
    case 'pay':
      return cmdPay(opts);
    default:
      out(HELP);
      return EXIT_USAGE;
  }
}

main()
  .then((code) => process.exit(code ?? EXIT_OK))
  .catch((err) => {
    const payload = formatFailure(err);
    if (process.argv.includes('--json')) printJson(payload);
    else printError(payload);
    process.exit(EXIT_ERROR);
  });
