---
name: rozo-checkout
description: >
  Pay an OpenRouter Coinbase Payment Link with BTC Lightning, or with USDT/USDC
  on Solana, BNB Chain, Ethereum, Polygon, Base or Stellar — the coins a
  Coinbase Payment Link cannot take directly. A bridge creates a one-time
  deposit order for the coin you actually hold, then a funder wallet settles the
  Coinbase invoice for you. Triggers on "rozo-checkout", "checkout-rozo",
  "pay-any", "pay with USDT on solana", "pay with USDT on bnb", "pay this link
  with bitcoin / lightning", "用 USDT 付这个链接", "用比特币付", "跨链付这个
  invoice", or on a payments.coinbase.com/payment-links/pl_* (or
  payment-sessions/paymentSession_*) URL mentioned together with any coin other
  than Base USDC. If the caller wants to pay in Base USDC, use pay-coinbase or
  pay-invoice instead — this skill adds a bridge they do not need.
metadata:
  version: 1.0.0
---

# Pay a Coinbase Payment Link with a non-Base-USDC coin

## What this is

A Coinbase Payment Link only accepts **USDC on Base**. This skill lets the
caller pay one with something else:

| You hold | Chain |
|---|---|
| USDT or USDC | Solana, BNB Chain, Ethereum, Polygon |
| USDC | Base, Stellar |
| BTC | Lightning (BOLT11) |

Native SOL, native BNB, native ETH and on-chain BTC are **not** supported —
always say "USDT **on** Solana", never "SOL".

How it works: the router quotes the Coinbase link, creates a one-time bridge
order with a deposit address for the coin you chose, and once your deposit
lands, a funder wallet pays the Coinbase invoice. **There is no discount** —
`callerPays` equals the invoice amount. If a response ever shows a discount, or
`callerPays` differs from the invoice, stop and explain; do not proceed.

Sibling skills: `pay-coinbase` (sign ERC-3009 yourself, Base USDC),
`pay-invoice` (hosted relay, Base USDC). Use those when the caller already has
Base USDC.

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

| Variable | Used by | Notes |
|---|---|---|
| `ROZO_CHECKOUT_EVM_KEY` | `send-evm.js` | 0x-prefixed 32-byte hex private key. Mode B only. |
| `ROZO_CHECKOUT_SOL_KEY` | `send-sol.js` | base58 secret key or JSON byte array. Mode B only. |
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
deposit amount and the order expiry do not exist yet. Mode B never signs
without that confirmation having happened in the same run.

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
authoritative deposit instructions, runs the reuse guard, checks the expiry
margins, checks the deposit address against the compromised-address list, and
re-checks that the Coinbase link is still payable.

Any non-zero exit here means **do not fund the order**. See Troubleshooting.

### Step 4 — final confirm (binding)

Present, from the `display` and `expiry` blocks:

```
About to pay:
  Merchant:   {merchant}
  Invoice:    {invoice.amount} USD   (you pay the full amount, no discount)
  Send:       {display.amount} on {display.chain}
  To:         {display.receiverAddressMasked}      <- masked, always
  Memo/tag:   {display.receiverMemoMasked or "none required"}
  Order ends: {expiry.effectiveDeadlineIso}  ({expiry.minutesOfSlack} min of slack)
  Reused existing order: {reused}

  Wrong token, wrong network or wrong amount is usually unrecoverable.
  Send exactly once — a second send to this one-time address is not
  guaranteed to be credited.

Confirm? (yes/no)
```

Use the masked address in prose. The **full** address, memo and BOLT11 string
live only in the machine-readable `deposit` object — hand that block over
verbatim when the user needs to copy it, and never re-type an address by hand.

Then pick a mode.

**Mode A (default) — the user pays from their own wallet.** Give them the
`deposit` block. For Lightning, `deposit.lnInvoice` is the BOLT11 string to
scan or paste, and `deposit.amount` is in **satoshis** (`deposit.isSats` is
true) — never call it "X BTC".

**Mode B (`--send`) — this machine pays from a hot wallet.** Only EVM chains
and Solana. Only after the confirmation above. Only with the key in the
environment:

```bash
# EVM (Ethereum, BNB Chain, Polygon, Base)
ROZO_CHECKOUT_EVM_KEY=... node scripts/dist/send-evm.js --rozo-payment-id <uuid>

# Solana
ROZO_CHECKOUT_SOL_KEY=... node scripts/dist/send-sol.js --rozo-payment-id <uuid>

# add --dry-run to see exactly what would be signed, without signing
# add --yes-large to exceed the $100 per-transaction cap
```

Mode B re-runs every check live before signing, verifies the RPC really is on
the intended chain, verifies the token's on-chain decimals, and records the
send locally **before** broadcasting so the same order can never be paid twice.
Caps: **$100 per transaction**, **$200 cumulative per session**.

### Step 5 — poll

```bash
node scripts/dist/status.js --rozo-payment-id <uuid> --watch --timeout 600
```

States: `awaiting_deposit` → `payin_detected` → `payin_confirmed` →
`bridging` → `paying_coinbase` → `settled`. Other terminal or exceptional
states: `expired_unfunded`, `underpaid`, `stuck_after_payment`.

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
| `LINK_NO_LONGER_PAYABLE` | the Coinbase link is used, expired, settled, or was consumed by someone else between quote and now | ask the merchant for a fresh link; do not fund anything |
| `ORDER_ALREADY_FUNDED` | an order for this link already shows money | **money-detected rule** — do not pay again, escalate |
| `REUSED_SOURCE_MISMATCH` | an existing order expects a different chain/token than the caller chose | let it expire, or pay the chain the order actually expects after re-confirming with the user |
| `CREATE_DRIFT` | the created order disagrees with the quote (merchant, amount or link) | do not fund it; let it expire unfunded and report the drift |
| `NO_DISCOUNT_VIOLATION` | the server reported a discount, or `callerPays ≠ invoice` | stop; this flow must charge the full invoice |
| `EXPIRY_MARGIN` / `EXPIRED` | not enough time left to fund, bridge and settle | start over with a fresh link |
| `BOLT11_TOO_SHORT` | the Lightning invoice has under 10 minutes left | re-run `create-order.js` for a fresh BOLT11 |
| `BLACKLIST_HIT` | the deposit address or the sender is on the compromised-address list | send nothing; report it to the operator immediately |
| `BLACKLIST_UNAVAILABLE` | the vendored list is missing, malformed or its digest does not match | the skill fails closed by design; do not work around it |
| `ALREADY_SENT` | a send is already recorded for this order | do not send again; poll `status.js` and check the chain |
| `DEPOSIT_CHANGED` | the live deposit details differ from what was confirmed | abort; re-run `create-order.js` and re-confirm |
| `BROADCAST_AMBIGUOUS` | the RPC errored but a transaction may be in flight | do **not** resend; check the sender on an explorer, then poll |
| `RPC_CHAIN_MISMATCH` | the RPC is not on the chain the order settles on | fix `ROZO_CHECKOUT_RPC_<chainId>`; never sign against it |
| `DECIMALS_MISMATCH` | the token's on-chain decimals disagree with expectations | do not sign — the amount could be off by orders of magnitude |
| `CAP_PER_TX` / `CAP_SESSION` | hot-wallet spend caps | `--yes-large` for a single large payment; the session cap needs a fresh state directory and a human decision |
| `UNSUPPORTED_SOURCE` | that coin/chain pair is not accepted | offer the table at the top of this file (the server's own list omits Lightning) |
| `MISSING_KEY` | the key env var is not exported | ask the user to export it in their own shell |
| `TRACKED_DOTENV` | a `.env` in this directory is tracked by git | untrack it before using hot-wallet keys here |
| `EXPIRY_UNPARSABLE` | a deadline is missing or unreadable | abort; never treat an unknown deadline as "probably fine" |

### The user pasted a `commerce.coinbase.com/pay/{uuid}` URL

That is a different, legacy protocol. Say so and stop.

### The user wants to pay in Base USDC

Point them at `pay-coinbase` or `pay-invoice`. This skill would add a bridge
they do not need.

### Underpaid

Report the shortfall and escalate. Do **not** send a top-up to the same
deposit address — a second payment to a one-time address is not guaranteed to
be credited.
