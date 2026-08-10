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
import {
  parseCliArgs,
  CliError,
  HELP,
  PICKER_OPTIONS,
  resolvePickerChoice,
} from './lib/cli-args.mjs';
import { chainFamily, isSatsUnit } from './lib/amounts.mjs';
import {
  detectAddressFamily,
  fetchWalletOptions,
  markPickerOptions,
  isProvablyShort,
} from './lib/wallet-check.mjs';
import { readPrefs, savePrefs } from './lib/prefs.mjs';
import { assertNotBlacklisted, loadBlacklist } from './lib/blacklist.mjs';
import { extractLinkId, isRozoPaymentId } from './lib/ids.mjs';
import { formatDeadline } from './lib/expiry.mjs';
import { planSignability } from './lib/key-source.mjs';
import { applyDotenv } from './lib/dotenv.mjs';

import { run as runQuote } from './quote.mjs';
import { run as runCreateOrder } from './create-order.mjs';
import { run as runStatus } from './status.mjs';
import { run as runSendEvm } from './send-evm.mjs';
import { run as runSendSol } from './send-sol.mjs';

class SkillErrorLike extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/**
 * Validate an address the user offered for the optional balance check, and
 * refuse a compromised one. Returns null when the address is unusable, since
 * the whole feature is optional.
 */
function vetPayerAddress(address) {
  const family = detectAddressFamily(address);
  if (!family) {
    out(`  ${yellow('That does not look like an EVM, Solana or Stellar address. Skipping the check.')}`);
    return null;
  }
  try {
    assertNotBlacklisted([{ address, family, role: 'wallet address' }], loadBlacklist());
  } catch (err) {
    out(`  ${red('✗')} ${err.message}`);
    return null;
  }
  return family;
}

/**
 * Ask for a wallet address to check balances against. Entirely optional: a
 * blank answer, an unusable address or a failed lookup all fall through to the
 * plain list.
 */
async function askPayerAddress(saved) {
  const savedMask = saved?.lastPayerAddress ? maskAddress(saved.lastPayerAddress) : null;
  const prompt = savedMask
    ? `  Wallet address [${savedMask}, Enter to reuse, 'n' for none]: `
    : "  Wallet address you'll pay from (optional — checks balances; Enter to skip): ";

  const answer = String(await ask(prompt)).trim();
  if (/^n(o)?$/i.test(answer)) return null;
  const address = answer || saved?.lastPayerAddress || null;
  if (!address) return null;

  // A remembered address is re-vetted exactly like a freshly typed one.
  const family = vetPayerAddress(address);
  return family ? { address, family } : null;
}

/**
 * Interactive coin picker, shown only when the caller is on a terminal and
 * gave no coin. Grouped by coin so the list reads as three short blocks
 * rather than eleven flat lines. When a wallet address is supplied, rows are
 * annotated with what that wallet appears to hold and affordable ones sort
 * first — a hint only; the payment still comes from whichever wallet the user
 * actually opens.
 */
async function pickSource({ invoiceUsd, saved, fresh }) {
  const payer = await askPayerAddress(fresh ? null : saved);

  let marked = PICKER_OPTIONS.map((o) => ({ ...o, mark: 'unchecked', balanceUsd: null }));
  let checked = null;
  if (payer) {
    out(dim('  Checking balances…'));
    const result = await fetchWalletOptions({ address: payer.address, usdRequired: invoiceUsd });
    if (result.ok) {
      marked = markPickerOptions(PICKER_OPTIONS, result);
      checked = result;
    } else {
      out(`  ${yellow(`Could not check balances (${result.reason}). Showing all coins.`)}`);
    }
  }

  out();
  out(`  ${bold('Which coin do you want to pay with?')}`);
  const savedPreset = fresh ? null : saved?.lastPreset ?? null;
  let group = null;
  for (const o of marked) {
    if (o.token !== group) {
      group = o.token;
      out();
      out(`  ${dim(o.token)}`);
    }
    const badge =
      o.mark === 'affordable'
        ? green(`✓ $${Number(o.balanceUsd ?? 0).toFixed(2)} available`)
        : o.mark === 'insufficient'
          ? dim('✗ insufficient')
          : dim('— not checked');
    const star = savedPreset === o.preset ? bold(' (last used)') : '';
    out(`    ${String(o.number).padStart(2)}. ${o.chain.padEnd(12)} ${badge}${star}`);
  }
  out();

  const defaultChoice = savedPreset ? ` [Enter for ${savedPreset}]` : '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = String(await ask(`  Number 1-${PICKER_OPTIONS.length}${defaultChoice}: `)).trim();
    const raw = answer || savedPreset;
    if (!raw) {
      out(`  ${yellow('Type the number of a coin.')}`);
      continue;
    }
    try {
      const choice = resolvePickerChoice(raw);
      if (checked && isProvablyShort(choice, checked)) {
        out(`  ${yellow('That wallet appears not to hold enough for this invoice.')}`);
        out(`  ${dim('You can still choose it — you may be paying from a different wallet.')}`);
      }
      // Echo the shortcut so the next run can skip this step.
      out(`  ${dim(`→ same as: --with ${choice.preset}`)}`);
      out();
      return {
        chainId: choice.chainId,
        tokenSymbol: choice.tokenSymbol,
        preset: choice.preset,
        payer,
      };
    } catch (err) {
      out(`  ${yellow(err.message)}`);
    }
  }
  throw new CliError('BAD_CHOICE', 'No valid choice after three attempts.');
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
  // Reading a payment link is a network round trip that has been measured at
  // 25s+. Without a line here the first output is the merchant block, and the
  // wait is indistinguishable from a hung process.
  if (!opts.json) out(dim('  Reading the payment link…'));
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
  if (!opts.json) out(dim('  Checking payment status… (no money moves)'));
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
  if (payload.expiry?.expiresIn && !payload.terminal) {
    out(`  Expires in ${payload.expiry.expiresIn}`);
  }
  if (payload.payin?.txHash) out(`  Pay-in  ${payload.payin.txHash}`);
  if (payload.guidance) out(`  ${payload.escalate ? red(payload.guidance) : dim(payload.guidance)}`);
  printMoneyWarning(payload);
  out();
  return exitCode;
}

function presetFor(chainId, tokenSymbol) {
  const hit = PICKER_OPTIONS.find(
    (o) => o.chainId === String(chainId) && o.tokenSymbol === String(tokenSymbol).toUpperCase(),
  );
  return hit ? hit.preset : null;
}

function stateLabel(state) {
  if (state === 'settled') return green(bold(state));
  if (['underpaid', 'stuck_after_payment', 'unknown'].includes(state)) return red(bold(state));
  if (state === 'expired_unfunded') return yellow(bold(state));
  return bold(state);
}

async function cmdPay(opts) {
  let sendResult = null;

  const saved = opts.fresh ? null : readPrefs();
  let chosenPreset = null;
  let payer = null;

  // The invoice amount drives the balance check, so quote before picking.
  let invoiceUsd = null;
  if (!opts.source || opts.payer) {
    if (!opts.json) out(dim('  Reading the payment link…'));
    const q = await step(runQuote, ['--url', opts.target]);
    if (!q.payload.success) {
      if (opts.json) printJson(q.payload);
      else printError(q.payload);
      return q.exitCode;
    }
    invoiceUsd = Number(q.payload.invoice?.amount);
  }

  // No coin given. On a terminal we ask; for a script or an agent this stays a
  // hard error — silently defaulting to some chain would be a way to lose money
  // on a network the caller never chose.
  if (!opts.source) {
    if (!process.stdin.isTTY || opts.json) {
      throw new CliError(
        'MISSING_PRESET',
        'No coin specified. Pass --with (e.g. --with usdt-solana), or run this on a ' +
          'terminal to choose from a list. There is no default.',
      );
    }
    const picked = await pickSource({ invoiceUsd, saved, fresh: opts.fresh });
    opts.source = { chainId: picked.chainId, tokenSymbol: picked.tokenSymbol };
    chosenPreset = picked.preset;
    payer = picked.payer;
  } else if (opts.payer) {
    // Non-interactive: an explicit coin plus an explicit wallet is the one
    // case where a provable shortfall should fail early rather than after a
    // deposit address has been printed.
    const family = detectAddressFamily(opts.payer);
    if (!family) {
      throw new CliError('BAD_PAYER_ADDRESS', 'That is not a recognisable EVM, Solana or Stellar address.');
    }
    assertNotBlacklisted([{ address: opts.payer, family, role: 'wallet address' }], loadBlacklist());
    const result = await fetchWalletOptions({ address: opts.payer, usdRequired: invoiceUsd });
    if (isProvablyShort(opts.source, result)) {
      throw new SkillErrorLike(
        'INSUFFICIENT_BALANCE',
        `${opts.payer.slice(0, 6)}…${opts.payer.slice(-4)} does not appear to hold enough ` +
          `${opts.source.tokenSymbol} for a $${invoiceUsd} invoice. Choose another coin, or ` +
          'omit --payer to proceed anyway from a different wallet.',
      );
    }
    if (!result.ok && !opts.json) {
      out(`  ${yellow(`Could not check balances (${result.reason}). Continuing.`)}`);
    } else if (result.ok && !opts.json) {
      // Say so when the wallet CAN pay, not only when it cannot. A check that
      // is silent on success is indistinguishable from a check that never ran,
      // which is the wrong impression to leave right before someone commits
      // money. "Not checked" is also a distinct, useful answer: the balance
      // service only covers some chains, so absence of a row is not a verdict.
      const hit = (result.options ?? []).find(
        (o) =>
          o.chainId === String(opts.source.chainId) &&
          o.tokenSymbol === String(opts.source.tokenSymbol).toUpperCase(),
      );
      const short = `${opts.payer.slice(0, 6)}…${opts.payer.slice(-4)}`;
      if (hit?.balanceUsd != null) {
        out(`  ${dim(`Payer ${short} holds about $${hit.balanceUsd} of ${opts.source.tokenSymbol} — enough for this invoice.`)}`);
      } else {
        out(`  ${dim(`Payer ${short}: balance not reported for this coin, so it was not verified.`)}`);
      }
    }
    payer = { address: opts.payer, family };
  }

  const { chainId, tokenSymbol } = opts.source;
  const baseArgs = ['--url', opts.target, '--chain', chainId, '--token', tokenSymbol];

  // --- 0. Mode B preflight: can this machine actually sign? ----------------
  // Resolving the key source is local and cheap, but it used to happen inside
  // the send script — i.e. after the order existed and after the CLI had
  // already printed "Sending…". A user with no key configured watched a
  // payment tool claim it was sending, then fail, with no way to tell whether
  // money had moved. Answer the question before either of those.
  //
  // This only PLANS the source (which file or env var would be used); it never
  // loads or decrypts key material. That still happens in the send script,
  // once, at signing time.
  // --dry-run is included deliberately: it resolves a key source too (it
  // reports which one it "would sign with"), so without this it fails just as
  // late, only with a quieter label.
  if (opts.send) {
    const family = chainFamily(chainId);
    // Stellar and Lightning have no --send path at all; that case is reported
    // further down as SEND_UNSUPPORTED_CHAIN, which says something clearer
    // than "no key found" would.
    if (family === 'evm' || family === 'solana') {
      // Throws NO_KEY_SOURCE (or a keyfile-specific code) with the exact
      // remedy for this chain. Nothing has been created yet, so there is no
      // order left expiring behind the failure.
      planSignability({
        family,
        keyfile: opts.keyfile,
        envFile: opts.envFile,
        applyEnvFile: applyDotenv,
      });
    }
  }

  // --- 1. create the order; the deposit address is withheld at this point ---
  if (!opts.json) out(dim('  Creating a one-time order… (no money moves)'));
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

  // Remember the setup for next time: address, coin and when. Never a key,
  // never a balance, never anything about the invoice.
  savePrefs({
    lastPayerAddress: payer?.address,
    lastAddressFamily: payer?.family,
    lastPreset: chosenPreset || presetFor(chainId, tokenSymbol),
  });

  if (!opts.json) {
    out();
    out(`  ${bold(p.merchant ?? 'Unknown merchant')}`);
    out(`  Invoice   ${bold(`${p.invoice?.amount} ${p.invoice?.currency ?? 'USD'}`)}`);
    out(`  You send  ${bold(p.display?.amount)} on ${bold(p.display?.chain)}`);
    out(`  To        ${p.display?.payToMasked} ${dim('(full address shown after you confirm)')}`);
    if (p.display?.hasMemo) {
      out(`  Memo      ${p.display.receiverMemoMasked} ${dim(`(${p.display.memoType})`)}`);
    }
    const deadline = formatDeadline(p.expiry?.effectiveDeadlineIso);
    out(`  Expires   ${bold(deadline ?? `in ${p.expiry?.expiresIn ?? '?'}`)}`);
    out(`  ${dim('After that this order cannot be used and a new one must be created.')}`);
    // Say plainly which of the two situations this is. The API's `reused` flag
    // answers "did an order already exist", which flips to true on the confirm
    // call for the very order this run just made — accurate, and confusing to
    // read across two adjacent steps. The user only needs to know whether a
    // second order was created. One never is.
    out(
      p.reused
        ? `  ${dim(`Reusing existing unpaid order ${p.rozoPaymentId} — nothing new was created.`)}`
        : `  ${dim(`Order created: ${p.rozoPaymentId}`)}`,
    );
    out(`  ${dim('An order you never fund simply expires and costs nothing.')}`);
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
  if (!opts.json) out(dim('  Confirming and releasing the deposit details… (no money moves yet)'));
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

  // Deliberately does NOT echo confirmed.payload.reused. That flag is true here
  // for the order this same run created seconds ago, so surfacing it reads as
  // "wait, which order is this?". The invariant the user cares about is stated
  // instead, and it is always true: confirming never creates a second order.
  if (!opts.json) {
    out(`  ${dim(`Confirming order ${rozoPaymentId} — no second order was created.`)}`);
  }

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
    if (opts.keyfile) sendArgs.push('--keyfile', opts.keyfile);
    if (opts.envFile) sendArgs.push('--env-file', opts.envFile);

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
      if (sent.payload.keySource) out(`  ${dim(`would sign with ${sent.payload.keySource}`)}`);
      out(`  ${green('✓')} Dry run only — nothing was signed or broadcast.`);
      out();
      return sent.exitCode;
    } else {
      if (sent.payload.sent?.keySource) {
        out(`  ${dim(`signing with ${sent.payload.sent.keySource}`)}`);
      }
      out(`  ${green('✓')} Sent. tx ${sent.payload.txHash}`);
      out();
      savePrefs({ lastPreset: chosenPreset || presetFor(chainId, tokenSymbol) });
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
    if (deposit.receiverMemo) {
      // Naming the type matters: a numeric-looking memo sent as MEMO_ID does
      // not match, and the payment is lost.
      out(
        `    Memo     ${bold(deposit.receiverMemo)}  ` +
          `${red(`(required, ${deposit.receiverMemoType})`)}`,
      );
    }
    if (deposit.expiresIn) out(`    Expires  in ${bold(deposit.expiresIn)}`);
  }
  out();
  const unit = isSatsUnit(deposit.amountUnit) ? 'sats' : deposit.tokenSymbol;
  const where = deposit.lnInvoice ? 'over Lightning' : `on ${deposit.chain}`;
  out(
    `  Make sure the wallet you pay from holds at least ` +
      `${bold(`${deposit.amount} ${unit}`)} ${where}.`,
  );
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
      try {
        return await cmdPay(opts);
      } catch (err) {
        // A usage problem discovered after parsing (no coin, on a non-TTY)
        // should still exit 2, like every other usage error.
        if (err instanceof CliError) {
          const payload = formatFailure(err);
          if (opts.json) printJson(payload);
          else {
            printError(payload);
            out(dim('\n  rozo-checkout --help for usage.'));
          }
          return EXIT_USAGE;
        }
        throw err;
      }
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
