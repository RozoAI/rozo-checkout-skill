---
name: rozo-checkout
description: >
  Pay an OpenRouter Coinbase Payment Link with Stellar, Solana, BNB Chain,
  Ethereum, Polygon, Base (USDT/USDC) or Bitcoin Lightning. A bridge creates a
  one-time deposit order for the coin you actually hold, then a funder wallet
  settles the Coinbase invoice for you. Use when a
  payments.coinbase.com/payment-links/pl_* (or
  payment-sessions/paymentSession_*) URL should be paid with any of these
  coins, or on "rozo-checkout" / "pay this link with bitcoin".
metadata:
  version: 1.0.0

  # Declared capabilities — what this skill can actually do, so reviewers and
  # scanners do not have to reverse-engineer it from the bundle.
  permissions:
    network_endpoints:
      - apiserver.mpprouter.dev   # quote the Coinbase link, create/track the order
      - intentapiv4.rozo.ai       # bridge order status (payment-api)
      - intentapi.rozo.ai         # wallet balance / payment-option assistance
      - "per-chain public RPCs"   # Mode B only: broadcast the signed transfer
    environment_variables:
      read_only:
        - ROZO_CHECKOUT_EVM_KEY          # Mode B (--send) only
        - ROZO_CHECKOUT_SOL_KEY          # Mode B (--send) only
        - ROZO_CHECKOUT_EVM_KEYSTORE     # Mode B (--send) only
        - ROZO_CHECKOUT_KEYSTORE_PASSPHRASE
        - "ROZO_CHECKOUT_RPC_<chainId>"
        - ROZO_CHECKOUT_STATE_DIR
        - ROZO_CHECKOUT_MPP_BASE         # endpoint overrides (testing/self-host)
        - ROZO_CHECKOUT_INTENTS_BASE
        - ROZO_CHECKOUT_INTENT_API
    filesystem:
      - "~/.rozo-checkout/  (state + prefs + optional .env; created by this tool)"
      - ".env in the working directory or a --env-file path (ROZO_CHECKOUT_* keys only)"
      - "Mode B key files, read-only: ~/.config/solana/id.json, a --keyfile path, or the ROZO_CHECKOUT_EVM_KEYSTORE path"
      - ".git metadata read-only (index, and gitdir/commondir resolution for worktrees), to refuse git-tracked key files"
    spending:
      - "Mode B (--send) signs and broadcasts one ERC-20/SPL transfer, capped at $1,100,"
      - "only after create-order --confirm recorded a digest-bound confirmation."
    subprocess: none
  default_mode_needs_no_credentials: true
---

# Pay a Coinbase Payment Link with Stellar, Solana, BNB Chain, Bitcoin and more

## What this is

A Coinbase Payment Link only accepts **USDC on Base**. This skill lets the
caller pay one with something else:

| You hold | Chain |
|---|---|
| USDT or USDC | Solana, BNB Chain, Ethereum, Polygon |
| USDC | Base, Stellar |
| BTC | Lightning (BOLT11) — any wallet that pays an invoice works, including Cashu/ecash wallets that melt to Lightning |

Native SOL, native BNB, native ETH and on-chain BTC are **not** supported —
always say "USDT **on** Solana", never "SOL".

How it works: the router quotes the Coinbase link, creates a one-time bridge
order with a deposit address for the coin you chose, and once your deposit
lands, a funder wallet pays the Coinbase invoice. **There is no discount** —
`callerPays` equals the invoice amount. If a response ever shows a discount, or
`callerPays` differs from the invoice, stop and explain; do not proceed.

## Runtime

Run every command from the repository root (the directory containing
`SKILL.md`, `scripts/`, `package.json`). If the harness sets
`${CLAUDE_PLUGIN_ROOT}`, use that.

```bash
cd "$SKILL_ROOT"
node scripts/dist/quote.js --url "<coinbase link>"
```

Each script prints **one JSON object on stdout**. Exit codes:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | refused or failed — read `error.code` |
| `2` | usage error |
| `3` | submitted but not confirmed in the wait window (money may be in flight) |

The bundles in `scripts/dist/` are self-contained; `npm install` is only needed
to rebuild them (`npm run build`).

## Environment variables

**Mode A — the default path — needs no key, no environment variable and no
configuration at all.** The variables below exist only for Mode B (`--send`),
where this machine signs on the user's behalf. Never ask a user to set one
unless they have explicitly asked for Mode B.

The recommended way to have an agent send the deposit is not to configure
hot-wallet keys here. In order of preference: first, the default keyless path —
the user pays from their own wallet. Second, for Stellar sources, the separate
`stellar-agent-wallet` skill (ClawHub: `shawnmuggle/stellar-agentic-wallet`)
pays the deposit address and memo via its `send-raw` command, with its own
file-based key handling and confirmation prompts — no `ROZO_CHECKOUT_*`
variable is involved. Only for unattended EVM/Solana automation does Mode B
apply, and then with a dedicated hot wallet holding a low balance.

Mode B takes its signing key from the first of these that exists:
`--keyfile <path>`; then `~/.config/solana/id.json` for Solana or
`ROZO_CHECKOUT_EVM_KEYSTORE` for EVM; then a raw key in the environment. The
environment variables below may also be set in a `.env` — either in the
working directory or at `~/.rozo-checkout/.env`, whichever is found first, or an explicit
`--env-file <path>`. Only `ROZO_CHECKOUT_*` keys are read from it, and the
real environment wins over the file. Note that the working directory is the
skill's own directory whenever you follow the run commands above, so
`~/.rozo-checkout/.env` is the right place for a user's own settings. A
generic `~/.env` is deliberately NOT read: it belongs to the user and usually
holds unrelated credentials. If theirs lives elsewhere, pass `--env-file
<path>` rather than asking them to move it.

| Variable | Used by | Notes |
|---|---|---|
| `ROZO_CHECKOUT_EVM_KEYSTORE` | `send-evm.js` | **Mode B only.** Path to an encrypted V3 JSON keystore. Preferred over a raw key. |
| `ROZO_CHECKOUT_KEYSTORE_PASSPHRASE` | `send-evm.js` | **Mode B only.** Keystore passphrase for unattended runs. On a terminal it is prompted instead. |
| `ROZO_CHECKOUT_EVM_KEY` | `send-evm.js` | **Mode B only.** Raw 32-byte hex private key; the `0x` prefix is optional. For unattended automation. |
| `ROZO_CHECKOUT_SOL_KEY` | `send-sol.js` | **Mode B only.** Raw base58 secret key or JSON byte array. For unattended automation; `~/.config/solana/id.json` is used first when present. |
| `ROZO_CHECKOUT_RPC_<chainId>` | send scripts | optional RPC override, e.g. `ROZO_CHECKOUT_RPC_8453` |
| `ROZO_CHECKOUT_STATE_DIR` | all | optional; defaults to `$HOME/.rozo-checkout/state` |

Keys are read from the environment **only**. Never pass a key as a command-line
argument, never print one, never write one into a file, a prompt or a commit
message. If the shell does not already export the key, ask the user to export
it themselves — do not go hunting through `.env` files. The send scripts refuse
to run if a `.env` in the working directory is tracked by git.

## Confirmation thresholds

Read the USD amount from the invoice (`invoice.amount`).

| Amount | Confirmation | Narration |
|---|---|---|
| `≤ $1.00` | none — proceed | silent, report the result |
| `≤ $10.00` | none — proceed | one narrating line |
| `> $10.00` | **one explicit yes/no** | full summary, wait for "yes" |

The binding confirmation happens at **step 4 (final confirm)**, never before —
the pre-create preview cannot bind because the deposit address, the exact
deposit amount and the order expiry do not exist yet.

This is **enforced in code, not just documented**. `create-order.js` withholds
the full deposit address, memo and BOLT11 until it is re-run with `--confirm`,
and `--confirm` writes a confirmation record bound to a digest of those exact
instructions. The send scripts refuse to run without both `--send` and a
confirmation record whose digest still matches the live deposit data.

## The flow

### Step 1 — quote (read-only, costs nothing)

```bash
node scripts/dist/quote.js --url "https://payments.coinbase.com/payment-links/pl_01..."
```

Reports merchant, invoice amount, `callerPays`, the Coinbase expiry and the
supported source list. Exit 1 with `LINK_NO_LONGER_PAYABLE` means the link is
used or expired — ask the merchant for a fresh one and stop.

The `quoteReceipt` in the output lives about **60 seconds**. Do not save it;
`create-order.js` takes its own fresh quote.

### Step 2 — choose the source and preview

Ask the caller which coin and chain they want to pay with, or use what they
already told you. Narrate the plan: invoice amount, merchant, chosen
chain/token, `callerPays` (equal to the invoice — no discount). **This is not
the binding confirmation.**

### Step 3 — create the order

```bash
node scripts/dist/create-order.js --url "<coinbase link>" --chain 900 --token USDT
```

Chain ids: `1` Ethereum · `56` BNB Chain · `137` Polygon · `8453` Base ·
`900` Solana · `1500` Stellar · `lightning` Bitcoin Lightning.

Creating an order moves no money and costs nothing if left unfunded. In one
run it creates the order, verifies it against the quote, fetches the
authoritative deposit instructions, runs the reuse guard, validates that the
deposit instructions are complete, checks the expiry margins, checks the
deposit address against the compromised-address list, and re-checks that the
Coinbase link is still payable.

**Without `--confirm` the full deposit address, memo and BOLT11 are withheld**
(`deposit: null`, `depositWithheld: true`). You get everything you need to ask
the user — masked address, exact amount, both expiries, the
reused flag — and nothing that could be paid by accident.

Any non-zero exit here means **do not fund the order**. See Troubleshooting.

### Step 4 — final confirm (binding)

Present, from the `display` and `expiry` blocks of the run above:

```
About to pay:
  Merchant:   {merchant}
  Invoice:    {invoice.amount} USD   (you pay the full amount, no discount)
  Send:       {display.amount} on {display.chain}
  To:         {display.payToMasked}                <- masked, always
  Order ends: {expiry.effectiveDeadlineIso}  ({expiry.minutesOfSlack} min of slack)
  Reused existing order: {reused}

  The deposit amount can exceed the invoice: it includes the bridge and
  network fees.
  Wrong token, wrong network or wrong amount is usually unrecoverable.
  Send exactly once — a second send to this one-time address is not
  guaranteed to be credited.

Confirm? (yes/no)
```

Only after an explicit yes (per the threshold table), re-run the **exact same
command with `--confirm`**:

```bash
node scripts/dist/create-order.js --url "<coinbase link>" --chain 900 --token USDT --confirm
```

That reuses the same order, re-runs every check, releases the full `deposit`
block, and records the confirmation. Use the masked address in prose. The
**full** address, memo and BOLT11 string live only in the machine-readable
`deposit` object — hand that block over verbatim when the user needs to copy
it, and never re-type an address by hand.

Then pick a mode.

> **"Mode A" and "Mode B" are internal vocabulary. Never say them to the
> user.** They are how this document names a branch you take; they carry no
> meaning for someone who just wants an invoice paid. Say who sends the money
> and what the user has to do — nothing else about the mechanism.
>
> | Do not say | Say |
> |---|---|
> | "Stellar is Mode A only, no `--send`" | "I can't send Stellar for you — here's the address and memo to pay from your wallet" (or: "I'll pay it with your `stellar-agent-wallet`") |
> | "Mode B needs `ROZO_CHECKOUT_EVM_KEY`" | "To have me pay it directly I'd need a hot-wallet key configured; otherwise pay from your own wallet and I'll watch for it" |
> | "`CAP_PER_TX`: over the Mode B limit" | "That's over the $1,100 I'll sign for automatically — pay this one from your own wallet, which has no limit" |
>
> Whichever branch you take, the user should end up reading the same four
> things: the amount, the destination, the memo if there is one, and what they
> personally need to do next.

**Mode A (default) — the user pays from their own wallet. No key, no env var,
no setup.** Give them the
`deposit` block. For Lightning, `deposit.lnInvoice` is the BOLT11 string to
scan or paste, and `deposit.amount` is in **satoshis** (`deposit.isSats` is
true) — never call it "X BTC".

**Mode B (`--send`, optional) — this machine pays from a hot wallet.** Only
when the user has asked for it. Only EVM chains and Solana — there is no
`--send` for Stellar or Lightning; those are Mode A only. Only after the
confirmation above. This is the only path that needs a key. On Solana it uses
the `~/.config/solana/id.json` that `solana-keygen` already wrote; on EVM an
encrypted V3 keystore whose passphrase is prompted (never a flag). Either can
be named with `--keyfile`. A raw key in the environment still works for
unattended automation:

```bash
# EVM (Ethereum, BNB Chain, Polygon, Base)
ROZO_CHECKOUT_EVM_KEY=... node scripts/dist/send-evm.js --rozo-payment-id <uuid> --send

# Solana
ROZO_CHECKOUT_SOL_KEY=... node scripts/dist/send-sol.js --rozo-payment-id <uuid> --send

# --dry-run shows exactly what would be signed and signs nothing (no --send needed)
```

`--send` is mandatory; without it the script exits with `SEND_NOT_OPTED_IN`
and does nothing. Mode B re-runs every check live before signing, re-proves
payability as the last step before broadcast, verifies the RPC really is on the
intended chain, verifies the token's on-chain decimals, signs before
broadcasting so the transaction hash is known in advance, and records the send
locally **before** broadcasting so the same order can never be paid twice.
One limit: a single payment may not exceed **$1,100**. There is no override
flag. A larger invoice is paid via Mode A, which needs no key and has no limit.

### Step 5 — poll

```bash
node scripts/dist/status.js --rozo-payment-id <uuid> --watch --timeout 600
```

Always pass `--rozo-payment-id` when you have it. A link-only query cannot
reach the authoritative pay-in view (the router does not resolve the id from a
link alone), so the money-detected rule cannot be enforced; the script says so
via `authoritativeView: false` and exits non-zero rather than guessing.

States: `awaiting_deposit` → `payin_detected` → `payin_confirmed` →
`bridging` → `paying_coinbase` → `settled`. Other terminal or exceptional
states: `expired_unfunded`, `underpaid`, `stuck_after_payment`, and `unknown`
(the backend could not be read — **not** evidence that nothing was paid).

`settled` is only reported on real settlement evidence. The bridge reaching
`payment_completed` is not that evidence and shows as `paying_coinbase`.

### Step 6 — report

```
✓ Paid {invoice.amount} USD to {merchant} with {token} on {chain}.
  linkId:        {linkId}
  rozoPaymentId: {rozoPaymentId}
  pay-in tx:     {payin.txHash}
```

## The money-detected rule

**Once any pay-in exists** (`payin.txHash`, `payin.confirmedAt` or a non-zero
`amountReceived`), for the rest of the conversation:

- never describe the order as a plain failure
- never advise paying again, topping up, or "trying a different chain"
- never create a new order for the same Coinbase link
- preserve `linkId`, `rozoPaymentId` and every tx hash in your reply

If the state is `stuck_after_payment` or `underpaid`, escalate for manual
reconciliation with this wording:

> Your payment arrived on chain but the invoice has not been settled. I am not
> going to retry, because retrying could take a second payment. I have kept
> every identifier below and this needs a human to reconcile it.
>
> linkId: `{linkId}` · rozoPaymentId: `{rozoPaymentId}` · pay-in tx:
> `{payin.txHash}` · state: `{state}`

Then stop and hand off. Do not run any send script again.

## Troubleshooting

| `error.code` | What happened | What to do |
|---|---|---|
| `SEND_NOT_OPTED_IN` | a send script was run without `--send` | intentional; add `--send` only after the user has confirmed |
| `NOT_CONFIRMED` | no confirmation record for this order | run `create-order.js ... --confirm` after the user says yes |
| `CONFIRMATION_STALE` | the live deposit details changed since the confirmation | re-confirm with fresh details; never send against the old ones |
| `LINK_NO_LONGER_PAYABLE` | the Coinbase link is used, expired, settled, or was consumed by someone else between quote and now | ask the merchant for a fresh link; do not fund anything |
| `LINK_PAYABILITY_UNKNOWN` | the Coinbase state was incomplete, so payability could not be proved | treat as not payable; retry, and do not fund on a guess |
| `DEPOSIT_INCOMPLETE` | no positive amount, or a Lightning order with no BOLT11 yet | wait and re-run; nothing is payable yet |
| `DEPOSIT_MEMO_REQUIRED` | a Stellar order arrived without its memo | do not send; Stellar routes on a shared hub address plus the memo, so without it the payment is lost |
| `LOCK_TIMEOUT` | another rozo-checkout process holds the send lock | wait for it; never bypass by clearing the lock mid-flight |
| `TRACKED_DOTENV_UNVERIFIABLE` | env files exist but git could not prove they are untracked | fix git, or run from a directory with no env files |
| `TX_REVERTED` / `TX_FAILED` | the transfer landed and failed | no funds moved, but the order stays locked; investigate before retrying |
| `ORDER_ALREADY_FUNDED` | an order for this link already shows money | **money-detected rule** — do not pay again, escalate |
| `REUSED_SOURCE_MISMATCH` | an existing order expects a different chain/token than the caller chose | let it expire, or pay the chain the order actually expects after re-confirming with the user |
| `CREATE_DRIFT` | the created order disagrees with the quote (merchant, amount or link) | do not fund it; let it expire unfunded and report the drift |
| `NO_DISCOUNT_VIOLATION` | the server reported a discount, or `callerPays ≠ invoice` | stop; this flow must charge the full invoice |
| `EXPIRY_MARGIN` / `EXPIRED` | not enough time left to fund, bridge and settle | start over with a fresh link |
| `BOLT11_TOO_SHORT` | the Lightning invoice has under 10 minutes left | see "Lightning invoice too short" below |
| `BLACKLIST_HIT` | the deposit address or the sender is on the compromised-address list | send nothing; report it to the operator immediately |
| `BLACKLIST_UNAVAILABLE` | the vendored list is missing, malformed or its digest does not match | the skill fails closed by design; do not work around it |
| `ALREADY_SENT` | a send is already recorded for this order | do not send again; poll `status.js` and check the chain |
| `DEPOSIT_CHANGED` | the live deposit details differ from what was confirmed | abort; re-run `create-order.js` and re-confirm |
| `BROADCAST_AMBIGUOUS` | the RPC errored but a transaction may be in flight | do **not** resend; check the sender on an explorer, then poll |
| `RPC_CHAIN_MISMATCH` | the RPC is not on the chain the order settles on | fix `ROZO_CHECKOUT_RPC_<chainId>`; never sign against it |
| `DECIMALS_MISMATCH` | the token's on-chain decimals disagree with expectations | do not sign — the amount could be off by orders of magnitude |
| `CAP_PER_TX` | above the $1,100 per-payment limit for automated sending | no override exists; have the user pay from their own wallet (Mode A), which has no limit |
| `UNSUPPORTED_SOURCE` | that coin/chain pair is not accepted | offer the table at the top of this file (the server's own list omits Lightning) |
| `NO_KEY_SOURCE` | no keyfile, no `~/.config/solana/id.json`, no key env var | tell the user the three options; do not pick one for them. The message lists the `.env` paths that were searched — if theirs is somewhere else, pass `--env-file <path>` rather than moving their file |
| `KEYFILE_PERMISSIONS` | the key file is readable by other users | have them run `chmod 600 <path>` |
| `TRACKED_KEYFILE` | the key file is tracked by git | have them untrack it before signing with it |
| `ENV_FILE_PERMISSIONS` | the `.env` is readable by other users | have them run `chmod 600 .env` |
| `BAD_ENV_FILE` | a line in the `.env` is not `KEY=VALUE` | the error names the line number only; do not ask them to paste the line |
| `KEYSTORE_BAD_PASSPHRASE` | wrong keystore passphrase | let them retry; never echo or store what they typed |
| `KEYSTORE_PASSPHRASE_REQUIRED` | a keystore needs a passphrase but there is no terminal | set `ROZO_CHECKOUT_KEYSTORE_PASSPHRASE` for unattended runs |
| `MISSING_KEY` | the key env var is not exported | ask the user to export it in their own shell |
| `TRACKED_DOTENV` | a `.env` in this directory is tracked by git | untrack it before using hot-wallet keys here |
| `EXPIRY_UNPARSABLE` | a deadline is missing or unreadable | abort; never treat an unknown deadline as "probably fine" |

### Lightning invoice too short

Re-running `create-order.js` does **not** mint a fresh BOLT11: while the
existing order is unexpired the router reuses it, invoice and all. The options
are to wait for the order to expire and then create a new one, or to ask the
merchant for a fresh Coinbase link. Do not pay a BOLT11 with under ten minutes
left.

### The user pasted a `commerce.coinbase.com/pay/{uuid}` URL

That is a different, legacy protocol. Say so and stop.

### The user wants to pay in Base USDC

Not a special case. Base is a supported source like any other — chain `8453`,
token `USDC` — so run the normal flow and say nothing about modes, bridges or
alternative tools. Same steps, same confirmation, same deposit block, same
polling.

Do not send the user off to another skill for this. One consistent path is
worth more than a theoretical shortcut, and the shortcut is not obviously
cheaper anyway: a same-chain order does not bridge.

### Underpaid

Report the shortfall and escalate. Do **not** send a top-up to the same
deposit address — a second payment to a one-time address is not guaranteed to
be credited.
