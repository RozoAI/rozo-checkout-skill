# クイックスタート

[English](QUICKSTART.md) | [简体中文](QUICKSTART.zh.md) | **日本語** | [Español](QUICKSTART.es.md)

OpenRouter の Coinbase 決済リンク (Payment Link) を、Solana、BNB Chain、
Ethereum、Polygon、Base、Stellar 上の USDT/USDC、または Lightning 経由の BTC で支払います。所要 5 分。
仕組みと設計意図については [README.md](README.md) を参照してください。

## 始める前に

- **Node 18 以降**（`node -v`）。インストールは不要です。`scripts/dist/*.js` は
  自己完結型のバンドルです。
- 選んだチェーン上で、支払いたい通貨を保有している**ウォレット**。
- **Coinbase のリンク**。例:
  `https://payments.coinbase.com/payment-links/pl_01YOURLINKID`。
- アカウントも API キーも不要です。ここで使うエンドポイントはすべて公開です。

最初に一度だけ設定します:

```bash
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"
```

チェーン id: `1` Ethereum · `56` BNB Chain · `137` Polygon · `8453` Base ·
`900` Solana · `1500` Stellar · `lightning` Bitcoin Lightning。

## 1. 見積もりを取得する（読み取り専用、無料）

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

`"success": false` かつ `LINK_NO_LONGER_PAYABLE` の場合、そのリンクは使用済みか
期限切れです — 新しいリンクを依頼し、そこで中止してください。

## 2. 注文を作成する

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT
```

資金は動かず、入金のない注文はそのまま期限切れになります。この段階では完全な
入金アドレス (deposit address) は**伏せられます** — まず確認用にマスクされたサマリーが返ります。

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

**先へ進む前に必ず `display.amount` を確認してください。** 通常はインボイス金額より
大きくなります — ブリッジ (bridge) 手数料とネットワーク手数料が含まれるためです。`rozoPaymentId` を
控えておいてください。以降のコマンドはすべてこれを使います。

## 3. 確認する

支払うと決めたときにだけ、同じコマンドを `--confirm` 付きで実行し直してください:

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm
```

これで完全な入金詳細が開示され、送金スクリプトが要求する確認記録が残ります。

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

Lightning の場合、`deposit.lnInvoice` にスキャン用の BOLT11 文字列が入り、
`deposit.amount` は satoshi 単位になります。

## 4. 支払う

どちらか一方を選びます。**モード A** — 自分のウォレットから支払う: `deposit.chain` 上で、
`deposit.tokenSymbol` をちょうど `deposit.amount` だけ `deposit.receiverAddress` へ送金します。
`deposit.receiverMemo` がある場合はそれも付けてください。アドレスは JSON から
コピーしてください。決して手入力し直さないでください。

**モード B** — スクリプトにホットウォレットから支払わせる（EVM と Solana のみ）:

```bash
# 署名される内容を正確にプレビューします — 署名は一切行いません
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --dry-run

# 実際に送金します。--send は必須です。
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --send
```

Ethereum、BNB Chain、Polygon、Base では `send-evm.js` を `ROZO_CHECKOUT_EVM_KEY` と
併せて使います。上限: トランザクションごとに $100、セッションごとに $200。

```json
{
  "success": true,
  "submitted": true,
  "confirmed": true,
  "txHash": "3Bxs4h24hBjHziQ8UJqSjqjbjWQq2sQ3yV9Fq4HrVh5c"
}
```

## 5. 決済完了を監視する

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

状態は `awaiting_deposit` → `payin_detected` → `payin_confirmed` →
`bridging` → `paying_coinbase` → `settled` と遷移します。オンチェーンの
トランザクションが確認されても終わりではありません: `settled` になるまでポーリングを続けてください。

## うまくいかないとき

`error.code` を読んでください。遭遇しやすいのは次の 3 つです:

| `error.code` | 何が起きたか | どうするか |
|---|---|---|
| `LINK_NO_LONGER_PAYABLE` | そのリンクは既に誰かが支払ったか、期限切れです | 加盟店に新しいリンクを依頼してください。何も支払わないこと |
| `EXPIRY_MARGIN` | 入金・ブリッジ・決済完了を安全に行うには残り時間が足りません | その注文は期限切れにさせ、ステップ 1 からやり直してください |
| `ALREADY_SENT` | この注文に対する送金が既に記録されています | 再送信しては**いけません**。まず `status.js` を実行し、チェーンを確認してください |

**ウォレットから既に資金が出ている場合は、決して二重に支払わないでください。**
`linkId`、`rozoPaymentId`、すべてのトランザクションハッシュを保管し、人間に照合を
依頼してください。使い捨ての入金アドレスへの 2 回目の支払いは、入金として反映される
保証がありません。

エラーコードの完全な一覧は [README.md](README.md) に、エージェント向けの指示は
[SKILL.md](SKILL.md) にあります。
