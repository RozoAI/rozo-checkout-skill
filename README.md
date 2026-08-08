# rozo-checkout

**English** | [简体中文](docs/README.zh.md) | [日本語](docs/README.ja.md) | [Español](docs/README.es.md)

Pay an **OpenRouter Coinbase Payment Link** with a coin that link cannot take
directly — BTC over Lightning, or USDT/USDC on Solana, BNB Chain, Ethereum,
Polygon, Base or Stellar. A Coinbase Payment Link only accepts USDC on Base;
this routes the coin you actually hold through a bridge, and a funder wallet
settles the invoice for you. No account, no API key, no browser.

```bash
npx @rozoai/checkout pay <coinbase-link>
```

It asks which coin you want to pay with — paste your wallet address at the
prompt and it will mark which coins you can actually afford — then prints a
deposit address for you to pay from any wallet — **no private key, no environment variable, no
configuration** — and waits until the invoice is settled.

Know your coin already? Skip the question:

```bash
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

## Coins you can pay with

| Chain | `--with` | Chain id | Notes |
|---|---|---|---|
| Ethereum | `usdt-ethereum` `usdc-ethereum` | `1` | 6 decimals |
| BNB Chain | `usdt-bnb` `usdc-bnb` | `56` | 18 decimals |
| Polygon | `usdt-polygon` `usdc-polygon` | `137` | 6 decimals |
| Base | `usdc-base` | `8453` | 6 decimals |
| Solana | `usdt-solana` `usdc-solana` | `900` | SPL; native SOL not supported |
| Stellar | `usdc-stellar` | `1500` | `MEMO_TEXT` memo required — shown in the deposit block |
| Bitcoin Lightning | `btc-lightning` | `lightning` | BOLT11; amounts in satoshis |

Native gas coins (SOL, BNB, ETH, MATIC) and on-chain BTC are not accepted.

## Which wallet do I need?

**One wallet, on one chain — not one per chain.** Pick whichever coin above you
already hold and pay from wherever it already lives.

- **Any wallet works, and so does an exchange withdrawal.** The default path
  just prints a deposit block: send exactly that `amount` of that
  `tokenSymbol`, on that `chain`, to that `receiverAddress`. Nothing connects to
  a site and nothing is approved in a browser. In practice people use MetaMask
  or Rabby on the EVM chains, Phantom or Solflare on Solana, and a Lightning
  wallet such as Phoenix or Wallet of Satoshi for BTC.
- **Stellar is the one to be careful with.** Its deposits route through a shared
  address plus `receiverMemo`, so whatever you send from — exchange or wallet —
  must let you set a memo. Omit it and the payment is lost.
- **Lightning pays an invoice, not an address.** Scan or paste
  `deposit.lnInvoice`; there is no address to send to.
- **Only `--send` needs a private key**, read from `ROZO_CHECKOUT_EVM_KEY` or
  `ROZO_CHECKOUT_SOL_KEY`, and it covers EVM chains and Solana only. Everything
  else is keyless.

## Use it from your agent

The payload is the same everywhere: the one-liner above, or point the agent at
[llms.txt](llms.txt). Agents and scripts should always pass `--with` — the
picker only appears on a terminal, and there is deliberately no default coin. **Paying from your own wallet never needs a key.** Only
the optional `--send` flag signs locally: on Solana it uses the
`~/.config/solana/id.json` that `solana-keygen` already created, and on EVM an
encrypted JSON keystore whose passphrase is prompted. A raw key in the
environment (or a gitignored `.env`) still works for unattended automation.

<details>
<summary><b>Set up a local wallet for <code>--send</code></b> — .env template and per-wallet export steps</summary>

**None of this is needed for the default path.** Paying from your own wallet
needs no key and no configuration, and works with wallets that can never be
used here — including hardware wallets and exchange accounts.

A `.env` in the directory you run from, with every variable this tool reads:

```bash
# None of this is needed to pay from your own wallet. These are read only
# when you use --send.

# Solana secret key: a base58 string, or a JSON byte array. Only needed if you
# do NOT have ~/.config/solana/id.json, which is picked up automatically.
ROZO_CHECKOUT_SOL_KEY=REPLACE_ME_base58_secret_key

# EVM raw private key: 64 hex characters, 0x prefix optional. The least safe
# option — prefer the keystore below.
ROZO_CHECKOUT_EVM_KEY=0x0000000000000000000000000000000000000000000000000000000000000000

# EVM encrypted V3 keystore: path to the file. Preferred over the raw key.
ROZO_CHECKOUT_EVM_KEYSTORE=/replace/me/keystores/my-hot-wallet

# Passphrase for that keystore. Only for unattended runs; on a terminal you
# are prompted instead, and nothing is stored.
ROZO_CHECKOUT_KEYSTORE_PASSPHRASE=REPLACE_ME_not_a_real_passphrase

# Optional RPC overrides, one per chain id. 8453 = Base, 900 = Solana.
ROZO_CHECKOUT_RPC_8453=https://mainnet.base.org
ROZO_CHECKOUT_RPC_900=https://api.mainnet-beta.solana.com
```

Then lock it down and keep it out of git:

```bash
chmod 600 .env
echo '.env' >> .gitignore
```

**Solana**

- `solana-keygen new` writes `~/.config/solana/id.json`. Nothing to configure —
  it is found automatically. This is the path we recommend.
- **Phantom** → Settings → Export Private Key gives a **base58** string. Put it
  in `ROZO_CHECKOUT_SOL_KEY`.
- **Solflare** exports a base58 string in current versions and a JSON byte
  array in older ones. Both are accepted as-is.

**EVM**

- **MetaMask** and **Rabby** → Export private key gives 64 hex characters.
  Paste it into `ROZO_CHECKOUT_EVM_KEY` as-is; the `0x` prefix is optional.
- **Encrypted keystore (safer).** Browser wallets export raw keys, not
  keystores. To turn one into an encrypted keystore, use Foundry:
  `cast wallet import my-hot-wallet --interactive` prompts for the key and
  writes an encrypted V3 keystore to `~/.foundry/keystores/my-hot-wallet`
  (`--keystore-dir` changes where). Point `ROZO_CHECKOUT_EVM_KEYSTORE` at that
  file. `geth account import` also produces a V3 keystore.

**Wallets that cannot be used with `--send`:** hardware wallets (Ledger,
Trezor), WalletConnect-only mobile wallets, and exchange accounts. None of them
hand over a signing key, by design. Use the default keyless path instead — it
works with all of them.

</details>


<details>
<summary><b>Claude Code</b> — install the skill, or paste the one-liner</summary>

This repo is a Claude Code skill: it ships `SKILL.md` plus the executables in
`scripts/dist/`. Clone it into your skills directory and Claude Code picks it
up automatically.

```bash
git clone https://github.com/RozoAI/rozo-checkout-skill ~/.claude/skills/rozo-checkout
```

Or skip the install and just ask it to run:

```
Pay this OpenRouter link with USDT on Solana:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. Add `--send` only if you want Claude to sign from a
hot wallet, which needs the env key.
</details>

<details>
<summary><b>Codex CLI</b> — AGENTS.md, or run it directly</summary>

Codex reads `AGENTS.md` from the project root. Add a standing instruction so it
knows how to pay without being told each time:

```
To pay an OpenRouter / Coinbase payment link, run:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>OpenCode</b> — AGENTS.md, or run it directly</summary>

OpenCode also reads `AGENTS.md` from the project root, so the Codex snippet
above works unchanged. The shortest path is still the command itself:

```bash
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>Cline</b> — .clinerules, or run it directly</summary>

Cline reads standing instructions from `.clinerules` in the project root:

```
To pay an OpenRouter / Coinbase payment link, run:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>Cursor</b> — .cursor/rules, or run it directly</summary>

Add a project rule at `.cursor/rules/rozo-checkout.mdc`:

```
To pay an OpenRouter / Coinbase payment link, run:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>Hermes Agent</b> — run the one-liner in a session</summary>

Hermes Agent (Nous Research) has shell access and its own skill system. Start it
with `hermes` and ask:

```
Fetch https://checkout.rozo.ai/llms.txt, then pay this OpenRouter link:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>OpenClaw</b> — openclaw agent exec</summary>

OpenClaw's headless entry point runs a one-off task, which suits a payment you
trigger from a script or a chat channel:

```bash
openclaw agent exec "Pay this OpenRouter link with USDT on Solana by running: npx @rozoai/checkout pay <coinbase-link> --with usdt-solana"
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>Pi</b> — run the one-liner in a session</summary>

Pi is a BYOK terminal agent whose built-in tools include `bash`, so it can run
the command directly. Start it with `pi` and ask:

```
Pay this OpenRouter link with USDT on Solana by running:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

<details>
<summary><b>Terminal — no agent at all</b> — run the scripts step by step</summary>

Drive each step yourself. The bundles are self-contained; nothing to install
beyond Node 18+.

```bash
git clone https://github.com/RozoAI/rozo-checkout-skill && cd rozo-checkout-skill
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"

# Read-only quote, costs nothing
node scripts/dist/quote.js --url "$LINK"

# Create the order. The full deposit address is WITHHELD here; you get a
# masked summary to review first.
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT

# Once you have decided to pay, re-run with --confirm to release it
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm

# Pay the deposit block from any wallet, then watch it settle
node scripts/dist/status.js --rozo-payment-id <uuid> --watch
```

Each script prints exactly one JSON object on stdout. Exit `0` success, `1`
refused/failed (read `error.code`), `2` usage, `3` submitted but unconfirmed.
Full walkthrough: [QUICKSTART](docs/QUICKSTART.md).

Wallet: any wallet, no key. For hot-wallet sending see `send-evm.js` /
`send-sol.js`, which use your Solana CLI keypair or an encrypted keystore.
</details>

<details>
<summary><b>Any other agent</b> — point it at llms.txt</summary>

Any agent that can fetch a URL and run a command can do this:

```
Fetch https://checkout.rozo.ai/llms.txt into your context, then use it
to pay this OpenRouter link: <coinbase-link>
```

If the agent has no shell but can make HTTP requests, it can drive the four
public endpoints directly — see [how it works](docs/how-it-works.md).

Wallet: any wallet, no key. `--send` signs locally using your Solana CLI
keypair or an encrypted keystore, and supports EVM chains and Solana only —
Stellar and Lightning are Mode A only.
</details>

## Three rules worth knowing

- **The deposit address is one-time.** Never reuse one from an older order, a
  cached response or a screenshot.
- **Send the exact amount shown.** It is normally larger than the invoice — it
  includes the bridge and network fees.
- **Stellar deposits carry a memo, and it is `MEMO_TEXT`** — even when it looks
  like a number (`65371582` is text, not an id). Sending it as `MEMO_ID`
  produces a different memo and the payment will not be matched. The deposit
  block states the type as `receiverMemoType`.
- **Never pay a funded order twice.** If a payment has already been detected,
  stop and get a human to reconcile it; a second payment to a one-time address
  is not guaranteed to be credited.

The full list of what this refuses to do, and why, is in
[docs/safety.md](docs/safety.md).

## Links

- [Quick start](docs/QUICKSTART.md) — the five commands, with expected output
- [How it works](docs/how-it-works.md) — the flow, the endpoints, the identifiers
- [Safety design](docs/safety.md) — every rail, in detail
- [SKILL.md](SKILL.md) — agent-facing instructions · [llms.txt](llms.txt) — one-file summary
- [checkout.rozo.ai/agent](https://checkout.rozo.ai/agent.html) — the same thing on the web
- [Issues](https://github.com/RozoAI/rozo-checkout-skill/issues) — bugs and requests

## Changelog

- **0.1.3** — fixes found by the first real payment. The built bundles no
  longer crash with `__filename is not defined` on Node 22+ (the esbuild banner
  now shims `__filename`/`__dirname` as well as `require`, and every bundle is
  now executed by the test suite). Stellar deposits state their memo type
  (`MEMO_TEXT`, even when the memo looks numeric). Orders show remaining
  validity as a duration ("expires in 47m") in the deposit block and in
  `status`, with the exact command to make a fresh one. Reusing an existing
  unpaid order, and asking for a coin that differs from it, are both explained
  instead of reading as errors.
- **0.1.2** — Mode B no longer needs a raw private key in an environment
  variable. On Solana it uses the `~/.config/solana/id.json` that
  `solana-keygen` already wrote; on EVM an encrypted V3 keystore whose
  passphrase is prompted. `--keyfile` names either explicitly, and settings can
  come from a gitignored `.env`. Raw env keys still work for unattended
  automation. Key files and `.env` must be `chmod 600` and untracked by git.
- **0.1.1** — one spend limit instead of two: a single payment may not exceed
  $1,100 (sized for a $1,000 credit purchase plus its 5% fee), the cumulative
  session cap and the `--yes-large` override are removed. Docs make it explicit
  that paying from your own wallet needs no key or configuration.
- **0.1.0** — first release: `npx @rozoai/checkout`.

## License

MIT.
