# Quick start

**English** | [简体中文](QUICKSTART.zh.md) | [日本語](QUICKSTART.ja.md) | [Español](QUICKSTART.es.md)

Pay an OpenRouter Coinbase Payment Link with USDT/USDC on Solana, BNB Chain,
Ethereum, Polygon, Base or Stellar, or with BTC over Lightning. Five minutes.
For how it works and why, see [README.md](README.md).

## The one-liner

```bash
npx @rozoai/checkout pay https://payments.coinbase.com/payment-links/pl_01YOURLINKID --with usdt-solana
```

That runs every step below for you: quote, create, review, confirm, deposit
instructions, then polling until settlement. Coins for `--with`: `usdt-solana`,
`usdc-solana`, `usdt-bnb`, `usdc-bnb`, `usdt-ethereum`, `usdc-ethereum`,
`usdt-polygon`, `usdc-polygon`, `usdc-base`, `usdc-stellar`, `btc-lightning`.

Add `--send` to pay from a hot wallet rather than your own, and `--json` for
machine-readable output.

The rest of this page is the same flow run one step at a time, which is what
you want if something goes wrong or you are scripting it yourself.

## Before you start

- **Node 18 or newer** (`node -v`). Nothing else to install — `npx` fetches the
  CLI, and the cloned `scripts/dist/*.js` are self-contained bundles.
- **A wallet** holding the coin you want to pay with, on the chain you pick.
- **The Coinbase link**, e.g.
  `https://payments.coinbase.com/payment-links/pl_01YOURLINKID`.
- No account and no API key. Every endpoint here is public.

Set it once:

```bash
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"
```

Chain ids: `1` Ethereum · `56` BNB Chain · `137` Polygon · `8453` Base ·
`900` Solana · `1500` Stellar · `lightning` Bitcoin Lightning.

## 1. Quote it (read-only, free)

```bash
node scripts/dist/quote.js --url "$LINK"
```

```json
{
  "success": true,
  "merchant": "OpenRouter, Inc.",
  "invoice": { "amount": "5.00", "fiat": { "amount": "5.00", "currency": "USD" } },
  "callerPays": "5.00",
  "coinbaseExpiryIso": "2026-08-09T10:00:00.000Z"
}
```

`"success": false` with `LINK_NO_LONGER_PAYABLE` means the link is used or
expired — ask for a fresh one and stop.

## 2. Create the order

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT
```

No money moves, and an unfunded order simply expires. The full deposit address
is **withheld** at this stage — you get a masked summary to check first.

```json
{
  "success": true,
  "rozoPaymentId": "11111111-2222-4333-8444-555555555555",
  "invoice": { "amount": "5.000000", "currency": "USD" },
  "deposit": null,
  "depositWithheld": true,
  "display": {
    "chain": "Solana",
    "amount": "5.021000 USDT",
    "payToMasked": "9WzDXw...AWWM",
    "memoRequirement": "This deposit REQUIRES the memo/tag below. ..."
  },
  "expiry": { "effectiveDeadlineIso": "2026-08-08T11:00:00.000Z", "minutesOfSlack": 55 }
}
```

**Check `display.amount` before going on.** It is normally larger than the
invoice — it includes the bridge and network fees. Note the `rozoPaymentId`;
every later command uses it.

## 3. Confirm

Only once you have decided to pay, re-run the same command with `--confirm`:

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm
```

This releases the full deposit details and records the confirmation the send
scripts require.

```json
{
  "success": true,
  "confirmed": true,
  "deposit": {
    "chain": "Solana",
    "tokenSymbol": "USDT",
    "receiverAddress": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "receiverMemo": "rozo-901",
    "amount": "5.021000",
    "payTo": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
  }
}
```

For Lightning, `deposit.lnInvoice` holds the BOLT11 string to scan, and
`deposit.amount` is in satoshis.

## 4. Pay

Pick one. **Mode A** — pay from your own wallet: send exactly
`deposit.amount` of `deposit.tokenSymbol` to `deposit.receiverAddress`, on
`deposit.chain`, including `deposit.receiverMemo` if there is one. Copy the
address from the JSON; never retype it.

**Mode B** — let the script pay from a hot wallet (EVM and Solana only):

```bash
# Preview exactly what would be signed — signs nothing
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --dry-run

# Actually send. --send is mandatory.
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --send
```

Use `send-evm.js` with `ROZO_CHECKOUT_EVM_KEY` for Ethereum, BNB Chain,
Polygon and Base. Caps: $100 per transaction, $200 per session.

```json
{
  "success": true,
  "submitted": true,
  "confirmed": true,
  "txHash": "3Bxs4h24hBjHziQ8UJqSjqjbjWQq2sQ3yV9Fq4HrVh5c"
}
```

## 5. Watch it settle

```bash
node scripts/dist/status.js --rozo-payment-id <rozoPaymentId> --watch --timeout 600
```

```json
{
  "success": true,
  "state": "settled",
  "terminal": true,
  "payin": { "txHash": "3Bxs4h24...", "confirmedAt": "2026-08-08T10:05:00.000Z" }
}
```

States run `awaiting_deposit` → `payin_detected` → `payin_confirmed` →
`bridging` → `paying_coinbase` → `settled`. Your on-chain transaction
confirming is not the end: keep polling until `settled`.

## If something goes wrong

Read `error.code`. The three you are most likely to hit:

| `error.code` | What happened | What to do |
|---|---|---|
| `LINK_NO_LONGER_PAYABLE` | someone already paid the link, or it expired | ask the merchant for a fresh link; do not pay anything |
| `EXPIRY_MARGIN` | too little time left to fund, bridge and settle safely | let the order expire, then start again from step 1 |
| `ALREADY_SENT` | a send is already recorded for this order | do **not** send again; run `status.js` and check the chain first |

**If any money has already left your wallet, never pay again.** Keep the
`linkId`, the `rozoPaymentId` and every transaction hash, and get a human to
reconcile it. A second payment to a one-time deposit address is not guaranteed
to be credited.

The full error table is in [README.md](README.md), and the agent-facing
instructions are in [SKILL.md](SKILL.md).
