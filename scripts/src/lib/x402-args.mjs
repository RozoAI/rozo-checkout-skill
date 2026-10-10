/**
 * Argument parsing for `rozo-checkout x402 <topup|pay|balance>`. Pure.
 *
 *   x402 topup <usd> --with <coin>
 *   x402 pay <url> [--method POST] [--body '{…}'] [--header 'Name: value']…
 *                  [--max-usd 1.00] [--idempotency-key <uuid>] [--dry-run]
 *   (--prefer base|solana is still parsed but not advertised: only Base is payable today)
 *   x402 balance
 *
 * Separate from parseCliArgs because --header repeats and the flag set does
 * not overlap with the checkout `pay` command.
 */

import { CliError } from './cli-args.mjs';

export const X402_SUBCOMMANDS = ['topup', 'pay', 'balance'];

const BOOLEAN = new Set(['json', 'dry-run', 'help']);
const VALUE = new Set(['with', 'method', 'body', 'header', 'max-usd', 'prefer', 'idempotency-key']);
const REPEATABLE = new Set(['header']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const X402_HELP = `rozo-checkout x402: pay any x402 API from a prepaid Rozo balance.

USAGE
  npx @rozoai/checkout x402 topup <usd> --with <coin>
  npx @rozoai/checkout x402 pay <url> [--method POST] [--body '{...}'] [--header 'Name: value']
  npx @rozoai/checkout x402 balance

TOPUP COINS (--with)
  usdt-solana usdc-solana usdt-bnb usdc-bnb usdt-ethereum usdc-ethereum
  usdt-polygon usdc-polygon usdc-base usdc-stellar btc-lightning
  native (beta): eth-ethereum eth-base eth-arbitrum bnb-bnb sol-solana

PAY OPTIONS
  --method <m>            HTTP method (default GET)
  --body <s>              request body, sent as is
  --header 'Name: value'  extra request header; repeat for more
  --max-usd <n>           most this one call may cost (default 1.00)
  --idempotency-key <id>  reuse after an interrupted run so you are not charged twice
  --dry-run               read the 402 and show what would be paid; sign nothing

Payment leg: USDC on Base only (eip155:8453, x402 scheme "exact").
Solana payment leg is coming later.
Your request goes straight from this machine to the endpoint; Rozo only sees
the 402 payment requirements it is asked to sign.`;

export function parseX402Args(argv) {
  const positional = [];
  const flags = { header: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (BOOLEAN.has(key)) {
        flags[key] = value === undefined ? true : value !== 'false';
        continue;
      }
      if (VALUE.has(key)) {
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || (value.startsWith('--') && key !== 'body')) {
            throw new CliError('MISSING_VALUE', `--${key} needs a value.`);
          }
          i++;
        }
        if (REPEATABLE.has(key)) flags[key].push(value);
        else flags[key] = value;
        continue;
      }
      throw new CliError('UNKNOWN_FLAG', `Unknown option --${key} for x402.`);
    }
    if (a === '-j') {
      flags.json = true;
      continue;
    }
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    positional.push(a);
  }

  // positional[0] is "x402"
  const sub = positional[1];
  const json = Boolean(flags.json);
  if (flags.help || !sub || sub === 'help') return { command: 'x402', sub: 'help', json };
  if (!X402_SUBCOMMANDS.includes(sub)) {
    throw new CliError('UNKNOWN_COMMAND', `Unknown x402 command "${sub}". Expected one of: ${X402_SUBCOMMANDS.join(', ')}.`);
  }

  if (sub === 'balance') return { command: 'x402', sub, json };

  if (sub === 'topup') {
    const amount = positional[2];
    if (!amount) throw new CliError('MISSING_TARGET', 'Usage: rozo-checkout x402 topup <usd> --with <coin>');
    if (!flags.with) throw new CliError('MISSING_PRESET', 'A coin is required, e.g. --with usdt-solana');
    return { command: 'x402', sub, json, amount, coin: flags.with };
  }

  // pay
  const url = positional[2];
  if (!url) throw new CliError('MISSING_TARGET', 'Usage: rozo-checkout x402 pay <url>');
  if (flags.prefer !== undefined && !['base', 'solana'].includes(String(flags.prefer).toLowerCase())) {
    throw new CliError('BAD_VALUE', '--prefer must be base or solana.');
  }
  if (flags['idempotency-key'] !== undefined && !UUID_RE.test(flags['idempotency-key'])) {
    throw new CliError('BAD_VALUE', '--idempotency-key must be a UUID (the one a previous run printed).');
  }
  if (flags.method !== undefined && !/^[A-Za-z]+$/.test(flags.method)) {
    throw new CliError('BAD_VALUE', '--method must be an HTTP method like GET or POST.');
  }
  return {
    command: 'x402',
    sub,
    json,
    url,
    method: (flags.method ?? 'GET').toUpperCase(),
    body: flags.body,
    headers: flags.header,
    maxUsd: flags['max-usd'],
    prefer: flags.prefer ? String(flags.prefer).toLowerCase() : undefined,
    idempotencyKey: flags['idempotency-key'],
    dryRun: flags['dry-run'] === true,
  };
}

/** True when argv addresses the x402 command group. */
export function isX402Argv(argv) {
  const first = argv.find((a) => !a.startsWith('-'));
  return first === 'x402';
}
