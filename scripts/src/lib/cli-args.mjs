/**
 * CLI argument parsing and coin presets.
 *
 * Deliberately pure: no I/O, no network, no process access. Everything here is
 * unit-tested, because a preset that maps to the wrong chain would send real
 * money to the wrong network.
 */

import { SUPPORTED_SOURCES, isSupportedSource, chainName } from './amounts.mjs';
import { normalizeUtmSource } from './utm.mjs';
import { normalizeContactEmail } from './support.mjs';
import { isRozoPaymentId } from './ids.mjs';

export const COMMANDS = ['pay', 'quote', 'status', 'receipt', 'resume', 'help', 'version'];

/**
 * Chain aliases accepted in a preset. The canonical name is the key's value.
 * Kept explicit rather than fuzzy-matched: "eth" must never silently become
 * something other than Ethereum.
 */
export const CHAIN_ALIASES = {
  ethereum: '1',
  eth: '1',
  mainnet: '1',
  bnb: '56',
  bsc: '56',
  bnbchain: '56',
  polygon: '137',
  matic: '137',
  base: '8453',
  solana: '900',
  sol: '900',
  stellar: '1500',
  xlm: '1500',
  lightning: 'lightning',
  ln: 'lightning',
  bitcoin: 'lightning',
  btc: 'lightning',
};

/**
 * The interactive picker's menu, grouped by coin. Pure data: the TTY layer in
 * cli.mjs renders it and reads a number, but the number -> source mapping
 * lives here so it can be tested without a terminal.
 */
export const PICKER_OPTIONS = [
  { token: 'USDT', chain: 'Solana', chainId: '900' },
  { token: 'USDT', chain: 'BNB Chain', chainId: '56' },
  { token: 'USDT', chain: 'Ethereum', chainId: '1' },
  { token: 'USDT', chain: 'Polygon', chainId: '137' },
  { token: 'USDC', chain: 'Solana', chainId: '900' },
  { token: 'USDC', chain: 'BNB Chain', chainId: '56' },
  { token: 'USDC', chain: 'Ethereum', chainId: '1' },
  { token: 'USDC', chain: 'Polygon', chainId: '137' },
  { token: 'USDC', chain: 'Base', chainId: '8453' },
  { token: 'USDC', chain: 'Stellar', chainId: '1500' },
  { token: 'BTC', chain: 'Lightning', chainId: 'lightning' },
].map((o, i) => ({
  number: i + 1,
  ...o,
  tokenSymbol: o.token,
  // The flag a user could have typed instead, echoed back so they learn it.
  preset: `${o.token.toLowerCase()}-${
    { '900': 'solana', '56': 'bnb', '1': 'ethereum', '137': 'polygon', '8453': 'base', '1500': 'stellar', lightning: 'lightning' }[
      o.chainId
    ]
  }`,
}));

/**
 * Resolve what the user typed at the picker. Accepts the menu number, or the
 * preset name itself for anyone who already knows it. Pure and total.
 */
export function resolvePickerChoice(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new CliError('BAD_CHOICE', 'Nothing entered. Type the number of a coin.');
  if (/^\d+$/.test(raw)) {
    const option = PICKER_OPTIONS.find((o) => o.number === Number(raw));
    if (!option) {
      throw new CliError(
        'BAD_CHOICE',
        `${raw} is not on the list. Choose 1-${PICKER_OPTIONS.length}.`,
      );
    }
    return { chainId: option.chainId, tokenSymbol: option.tokenSymbol, preset: option.preset };
  }
  // Not a number: fall back to normal preset parsing, which has its own errors.
  const { chainId, tokenSymbol } = resolvePreset(raw);
  const option = PICKER_OPTIONS.find(
    (o) => o.chainId === chainId && o.tokenSymbol === tokenSymbol,
  );
  return { chainId, tokenSymbol, preset: option ? option.preset : raw.toLowerCase() };
}

export class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

/** Every preset that maps to a supported (chain, token) pair. */
export function listPresets() {
  const out = [];
  for (const s of SUPPORTED_SOURCES) {
    const chain = Object.entries(CHAIN_ALIASES).find(([, id]) => id === s.chainId)?.[0];
    for (const token of s.tokens) out.push(`${token.toLowerCase()}-${chain}`);
  }
  return out;
}

/**
 * Resolve a preset like "usdt-solana" / "btc-lightning" / "usdc-base" into
 * { chainId, tokenSymbol }. Throws CliError on anything unrecognised — never
 * guesses.
 */
export function resolvePreset(preset) {
  const raw = String(preset ?? '').trim().toLowerCase();
  if (!raw) {
    throw new CliError('MISSING_PRESET', 'A coin is required, e.g. --with usdt-solana');
  }
  const idx = raw.indexOf('-');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new CliError(
      'BAD_PRESET',
      `"${preset}" is not a valid coin. Use <token>-<chain>, e.g. usdt-solana. ` +
        `Known: ${listPresets().join(', ')}`,
    );
  }
  const tokenSymbol = raw.slice(0, idx).toUpperCase();
  const chainKey = raw.slice(idx + 1).replace(/[\s_]/g, '');
  const chainId = CHAIN_ALIASES[chainKey];
  if (!chainId) {
    throw new CliError(
      'BAD_PRESET',
      `Unknown chain "${raw.slice(idx + 1)}" in "${preset}". ` +
        `Known: ${[...new Set(Object.values(CHAIN_ALIASES))].map(chainName).join(', ')}`,
    );
  }
  if (!isSupportedSource(chainId, tokenSymbol)) {
    throw new CliError(
      'UNSUPPORTED_SOURCE',
      `${tokenSymbol} on ${chainName(chainId)} is not supported. ` +
        `Known: ${listPresets().join(', ')}`,
      { supported: SUPPORTED_SOURCES },
    );
  }
  return { chainId, tokenSymbol };
}

const BOOLEAN_FLAGS = new Set([
  'send',
  'yes',
  'json',
  'help',
  'version',
  'dry-run',
  'no-watch',
  'watch',
  'fresh',
]);

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  'with',
  'from',
  'chain',
  'token',
  'rpc',
  'timeout',
  'payer',
  'keyfile',
  'env-file',
  // Bitrefill invoice (pay) and provider override (status)
  'bitrefill-invoice',
  'to',
  'amount',
  'expires-at',
  'provider',
  // Optional channel label for reporting (pay, quote)
  'utm-source',
  // Optional contact email so ROZO can reach the payer (pay)
  'email',
]);

/**
 * --from accepts the preset in either order ("usdc-stellar" or
 * "stellar-usdc"), since people naturally say "pay from Stellar USDC".
 * Still exact: each half must resolve to a known token / chain.
 */
export function resolveFromPreset(value) {
  try {
    return resolvePreset(value);
  } catch (err) {
    const raw = String(value ?? '').trim();
    const idx = raw.indexOf('-');
    if (idx <= 0) throw err;
    try {
      return resolvePreset(`${raw.slice(idx + 1)}-${raw.slice(0, idx)}`);
    } catch {
      throw err;
    }
  }
}

/**
 * Parse a full argv tail (everything after the binary name) into a normalized
 * command descriptor. Pure and total: it either returns a descriptor or throws
 * a CliError with a usable message.
 */
export function parseCliArgs(argv) {
  const positional = [];
  const flags = {};

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
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = value === undefined ? true : value !== 'false';
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || value.startsWith('--')) {
            throw new CliError('MISSING_VALUE', `--${key} needs a value.`);
          }
          i++;
        }
        flags[key] = value;
        continue;
      }
      throw new CliError('UNKNOWN_FLAG', `Unknown option --${key}.`);
    } else if (a.startsWith('-') && a.length > 1) {
      const short = { h: 'help', v: 'version', y: 'yes', j: 'json' }[a.slice(1)];
      if (!short) throw new CliError('UNKNOWN_FLAG', `Unknown option ${a}.`);
      flags[short] = true;
    } else {
      positional.push(a);
    }
  }

  if (flags.help || positional[0] === 'help') return { command: 'help', json: Boolean(flags.json) };
  if (flags.version) return { command: 'version', json: Boolean(flags.json) };

  const command = positional[0];
  if (!command) return { command: 'help', json: Boolean(flags.json) };
  if (!COMMANDS.includes(command)) {
    throw new CliError(
      'UNKNOWN_COMMAND',
      `Unknown command "${command}". Expected one of: ${COMMANDS.join(', ')}.`,
    );
  }

  const target = positional[1];
  const json = Boolean(flags.json);

  // Optional channel label. Validated here so a typo is reported before any
  // order exists; undefined means "fall back to ROZO_CHECKOUT_UTM_SOURCE".
  let utmSource;
  if (flags['utm-source'] !== undefined && (command === 'pay' || command === 'quote')) {
    utmSource = normalizeUtmSource(String(flags['utm-source']));
    if (!utmSource) {
      throw new CliError(
        'BAD_VALUE',
        '--utm-source must be 1-100 characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit.',
      );
    }
  }

  if (command === 'quote') {
    if (!target) throw new CliError('MISSING_TARGET', 'Usage: rozo-checkout quote <coinbase-link>');
    return { command, target, json, ...(utmSource ? { utmSource } : {}) };
  }

  if (command === 'receipt') {
    if (!target) {
      throw new CliError(
        'MISSING_TARGET',
        'Usage: rozo-checkout receipt <rozoPaymentId | coinbase-link>',
      );
    }
    if (flags.provider !== undefined && !['coinbase', 'bitrefill'].includes(String(flags.provider))) {
      throw new CliError('BAD_VALUE', '--provider must be coinbase or bitrefill.');
    }
    return { command, target, json, provider: flags.provider };
  }

  if (command === 'resume') {
    if (!target) {
      throw new CliError('MISSING_TARGET', 'Usage: rozo-checkout resume <rozoPaymentId>');
    }
    if (!isRozoPaymentId(target)) {
      throw new CliError(
        'BAD_VALUE',
        'resume takes the order id (rozoPaymentId, a UUID) that pay printed, not a payment link.',
      );
    }
    return { command, target, json, yes: flags.yes === true };
  }

  if (command === 'status') {
    if (!target) {
      throw new CliError(
        'MISSING_TARGET',
        'Usage: rozo-checkout status <rozoPaymentId | coinbase-link>',
      );
    }
    if (flags.provider !== undefined && !['coinbase', 'bitrefill'].includes(String(flags.provider))) {
      throw new CliError('BAD_VALUE', '--provider must be coinbase or bitrefill.');
    }
    return {
      command,
      target,
      json,
      provider: flags.provider,
      watch: flags.watch === true,
      // Left undefined when absent so status can size the window itself:
      // 600s, or a Lightning invoice's remaining validity (max 60 min).
      timeout: flags.timeout === undefined ? undefined : Number(flags.timeout),
    };
  }

  // pay — a Bitrefill invoice is described by flags, not by a link.
  const bitrefillFlags = ['bitrefill-invoice', 'to', 'amount', 'expires-at'].filter(
    (k) => flags[k] !== undefined,
  );
  let bitrefill = null;
  if (bitrefillFlags.length) {
    if (
      flags['bitrefill-invoice'] === undefined ||
      flags.to === undefined ||
      flags.amount === undefined ||
      flags['expires-at'] === undefined
    ) {
      throw new CliError(
        'MISSING_VALUE',
        'A Bitrefill invoice needs --bitrefill-invoice <id> --to <0x…> --amount <USDC> --expires-at <ISO>.',
      );
    }
    if (target) {
      throw new CliError('CONFLICTING_FLAGS', 'Pass either a Coinbase link or --bitrefill-invoice, not both.');
    }
    bitrefill = {
      invoiceId: String(flags['bitrefill-invoice']).trim(),
      address: String(flags.to).trim(),
      amount: String(flags.amount).trim(),
      expiresAt: String(flags['expires-at']).trim(),
    };
  }
  if (flags.from !== undefined && flags.with !== undefined) {
    throw new CliError('CONFLICTING_FLAGS', 'Use either --with or --from, not both.');
  }

  if (!target && !bitrefill) {
    throw new CliError(
      'MISSING_TARGET',
      'Usage: rozo-checkout pay <coinbase-link> --with usdt-solana',
    );
  }

  let source;
  if (flags.chain !== undefined || flags.token !== undefined) {
    if (flags.chain === undefined || flags.token === undefined) {
      throw new CliError('MISSING_VALUE', '--chain and --token must be given together.');
    }
    if (flags.with !== undefined || flags.from !== undefined) {
      throw new CliError('CONFLICTING_FLAGS', 'Use either --with, or --chain plus --token.');
    }
    const chainId = String(flags.chain).trim();
    const tokenSymbol = String(flags.token).trim().toUpperCase();
    if (!isSupportedSource(chainId, tokenSymbol)) {
      throw new CliError(
        'UNSUPPORTED_SOURCE',
        `${tokenSymbol} on ${chainName(chainId)} is not supported.`,
        { supported: SUPPORTED_SOURCES },
      );
    }
    source = { chainId, tokenSymbol };
  } else if (flags.with !== undefined) {
    source = resolvePreset(flags.with);
  } else if (flags.from !== undefined) {
    source = resolveFromPreset(flags.from);
  } else {
    // No coin given. On a terminal the CLI offers a picker; for a non-TTY
    // caller this stays an error, decided in cli.mjs — an agent must be
    // explicit rather than fall back to some default chain.
    source = null;
  }

  // Optional contact email. Never required; a bad value is an error (not a
  // silent drop) so the user learns before an order exists.
  let email = null;
  if (flags.email !== undefined) {
    email = normalizeContactEmail(String(flags.email));
    if (email === undefined) {
      throw new CliError(
        'INVALID_EMAIL',
        '--email must be a valid email address, for example name@example.com. It is optional: leave it out to continue without one.',
      );
    }
  }

  const timeout = flags.timeout === undefined ? 900 : Number(flags.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new CliError('BAD_VALUE', '--timeout must be a non-negative number of seconds.');
  }

  return {
    command: 'pay',
    target: target ?? null,
    bitrefill,
    json,
    source,
    send: flags.send === true,
    yes: flags.yes === true,
    dryRun: flags['dry-run'] === true,
    watch: flags['no-watch'] !== true,
    timeout,
    timeoutExplicit: flags.timeout !== undefined,
    rpc: flags.rpc,
    payer: flags.payer,
    fresh: flags.fresh === true,
    keyfile: flags.keyfile,
    envFile: flags['env-file'],
    ...(utmSource ? { utmSource } : {}),
    ...(email ? { email } : {}),
  };
}

export const HELP = `rozo-checkout — pay a Coinbase Payment Link or a Bitrefill invoice
(USDC on Base) with BTC Lightning, or USDT/USDC on Solana, BNB Chain, Ethereum, Polygon, Base or Stellar.

USAGE
  npx @rozoai/checkout pay <coinbase-link>              (pick a coin from a list)
  npx @rozoai/checkout pay <coinbase-link> --with <coin>
  npx @rozoai/checkout pay --bitrefill-invoice <id> --to <0x…> --amount <USDC> --expires-at <ISO> --with <coin>
  npx @rozoai/checkout quote <coinbase-link>
  npx @rozoai/checkout status <rozoPaymentId | coinbase-link>
  npx @rozoai/checkout receipt <rozoPaymentId | coinbase-link>
  npx @rozoai/checkout resume <rozoPaymentId>
  npx @rozoai/checkout x402 <topup|pay|balance>      (pay any x402 API; see x402 --help)

COINS (--with)
  usdt-solana   usdc-solana   usdt-bnb      usdc-bnb
  usdt-ethereum usdc-ethereum usdt-polygon  usdc-polygon
  usdc-base     usdc-stellar  btc-lightning
  or give them raw:  --chain 900 --token USDT

By default, pay just prints an address for you to pay from any wallet:
no private key, no environment variable, no configuration.

OPTIONS
  --with <coin>   which coin to pay with. Omit it on a terminal and you get a
                  numbered list to choose from; scripts and agents must pass it.
  --send          optional. Sign from a hot wallet instead of paying yourself.
                  The only option that needs a key. On Solana it uses your
                  existing ~/.config/solana/id.json; on EVM an encrypted JSON
                  keystore. A single payment may not exceed $1,100; there is
                  no override.
  --keyfile <p>   with --send: the key to sign with. A solana-keygen keypair
                  file, or an encrypted V3 keystore for EVM (passphrase is
                  prompted, never passed as a flag).
  --env-file <p>  with --send: read hot-wallet settings from this file instead
                  of ./.env. Only ROZO_CHECKOUT_* keys are read from it.
  --yes, -y       skip the interactive confirmation (required when not a TTY)
  --dry-run       with --send, show what would be signed and sign nothing
  --json, -j      machine-readable output
  --no-watch      stop after showing the deposit instructions
  --timeout <s>   how long to poll for settlement (default 900; for Lightning,
                  the invoice's remaining validity, at most 60 minutes)
  --bitrefill-invoice <id>  pay a Bitrefill invoice created with "USDC on Base"
                  instead of a Coinbase link. Needs --to <0x… address Bitrefill
                  shows>, --amount <exact USDC amount> and --expires-at <ISO>
                  (required; refused under 5 minutes or over 30 minutes out).
  --from <coin>   same as --with; also accepts chain-first, e.g. stellar-usdc
  --payer <addr>  optional. Check what this wallet holds and mark the coin
                  list accordingly. Display help only; it never changes what
                  gets signed.
  --fresh         ignore the remembered wallet address and coin for this run
  --rpc <url>     override the RPC endpoint for --send
  --utm-source <s>  optional channel label for reporting; no identity, no
                  privilege. Overrides ROZO_CHECKOUT_UTM_SOURCE.
  --email <addr>  optional. A contact email stored with the order so ROZO can
                  reach you if the payment needs attention. Never required.
  --help, -h      this text
  --version, -v   print the version

EXAMPLES
  npx @rozoai/checkout pay https://payments.coinbase.com/payment-links/pl_01...
  npx @rozoai/checkout pay https://payments.coinbase.com/payment-links/pl_01... --with usdt-solana
  npx @rozoai/checkout pay pl_01... --with btc-lightning
  npx @rozoai/checkout pay pl_01... --with usdt-solana --email you@example.com
  npx @rozoai/checkout pay --bitrefill-invoice 8f3k2 --to 0xAbC…123 --amount 7.90 --expires-at 2026-10-01T12:00:00Z --with usdc-stellar
  npx @rozoai/checkout status 11111111-2222-4333-8444-555555555555
  npx @rozoai/checkout receipt 11111111-2222-4333-8444-555555555555 --json

RECEIPT
  receipt reads the order once (nothing is created or sent) and reports three
  layers separately: did your money reach Rozo, was the merchant invoice paid,
  and was the service delivered (always "unknown": Rozo cannot see OpenRouter
  credits). Exit 0 only when the merchant invoice is settled; 3 when it is
  still in flight or unknown; 1 when it expired unpaid or needs a human.
  In --json output from status and receipt, read paymentOutcome and
  nextAction. The older "success" field means the query worked, not that the
  invoice is paid.

RESUME
  resume picks up an order you created earlier and did not pay yet. It reads
  the order (nothing is created or sent), and if it is still unpaid and has
  enough time left it prints the hosted payment page and, after you confirm
  (or with --yes), the exact deposit instructions again. A paid order is
  reported as paid (exit 0); an expired one says so and how to start over.

PRIVACY
  Each order carries an anonymous install id: a random UUID created on first
  run and stored in ~/.rozo-checkout/prefs.json. If OPENROUTER_API_KEY is set,
  a one-way salted sha256 hash of it is sent too; the key itself is never
  sent, logged or stored. Delete prefs.json
  to reset the id; set ROZO_CHECKOUT_ANON_ID=off to send neither.

Creating an order moves no money; an unfunded order simply expires. Nothing is
paid until you confirm, and --send is required before anything is signed.

SUPPORT
  Email hi@rozo.ai, X https://x.com/ROZOai, Discord https://discord.gg/EfWejgTbuU`;
