# 快速开始

[English](QUICKSTART.md) | **简体中文** | [日本語](QUICKSTART.ja.md) | [Español](QUICKSTART.es.md)

用 Solana、BNB Chain、Ethereum、Polygon、Base 或 Stellar 上的 USDT/USDC，或者用走
Lightning 的 BTC，去支付一个 OpenRouter Coinbase 收款链接 (Payment Link)。五分钟搞定。
工作原理与设计理由见 [README.md](README.md)。

## 一行命令搞定

```bash
npx @rozoai/checkout pay https://payments.coinbase.com/payment-links/pl_01YOURLINKID --with usdt-solana
```

这一条命令会替你跑完下面的每一步：报价、创建订单、核对、确认、充值指令，然后一直轮询到结清。`--with` 可选的币种有：`usdt-solana`、`usdc-solana`、`usdt-bnb`、`usdc-bnb`、`usdt-ethereum`、`usdc-ethereum`、`usdt-polygon`、`usdc-polygon`、`usdc-base`、`usdc-stellar`、`btc-lightning`。

加 `--send` 就用热钱包付款而不是用你自己的钱包，加 `--json` 输出机器可读格式。

本页剩下的内容就是同一套流程，只不过一步一步来 —— 如果出了问题，或者你想自己写脚本，那才需要看它们。

## 开始之前

- **Node 18 或更高版本**（`node -v`）。别的什么都不用装 —— `npx` 会去拉取 CLI，而克隆下来的
  `scripts/dist/*.js` 都是自包含的打包产物。
- **一个钱包**，在你选的链上持有你想用来付款的币种。
- **那个 Coinbase 链接**，例如
  `https://payments.coinbase.com/payment-links/pl_01YOURLINKID`。
- 不需要账号，也不需要 API key。这里用到的每个端点都是公开的。

先设一次：

```bash
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"
```

链 id：`1` Ethereum · `56` BNB Chain · `137` Polygon · `8453` Base ·
`900` Solana · `1500` Stellar · `lightning` Bitcoin Lightning。

## 1. 报价（只读，免费）

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

`"success": false` 且带 `LINK_NO_LONGER_PAYABLE`，说明这个链接已被付过或已过期 ——
去要一个新的，然后停止。

## 2. 创建订单

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT
```

这一步不动任何资金，未付款的订单会自然过期。完整充值地址 (deposit address) 在此阶段
会被**扣留** —— 你只拿到打码后的摘要，先用它核对。

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

**继续之前务必核对 `display.amount`。** 它通常大于账单金额 —— 因为它包含了跨桥费用和
网络费用。记下 `rozoPaymentId`；后面每一条命令都要用它。

## 3. 确认

只有在你已经决定付款之后，才带上 `--confirm` 重新执行同一条命令：

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm
```

这会释放完整的充值详情，并记录下发送脚本所需的那条确认。

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

对于 Lightning，`deposit.lnInvoice` 里是供扫码的 BOLT11 字符串，`deposit.amount`
的单位是聪 (satoshis)。

## 4. 付款

二选一。**模式 A** —— 用你自己的钱包付：在 `deposit.chain` 上，把恰好
`deposit.amount` 数量的 `deposit.tokenSymbol` 发送到 `deposit.receiverAddress`，
如果有 `deposit.receiverMemo` 就带上它。地址直接从 JSON 里复制；绝不要手打重输。

**模式 B** —— 让脚本从热钱包付款（仅限 EVM 与 Solana）：

```bash
# 预览将要签名的确切内容 —— 不会签任何名
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --dry-run

# 真正发送。--send 是必需的。
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --send
```

Ethereum、BNB Chain、Polygon 和 Base 用 `send-evm.js` 配合 `ROZO_CHECKOUT_EVM_KEY`。
额度上限：单笔 $100，单会话 $200。

```json
{
  "success": true,
  "submitted": true,
  "confirmed": true,
  "txHash": "3Bxs4h24hBjHziQ8UJqSjqjbjWQq2sQ3yV9Fq4HrVh5c"
}
```

## 5. 观察结清

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

状态流转依次为 `awaiting_deposit` → `payin_detected` → `payin_confirmed` →
`bridging` → `paying_coinbase` → `settled`。你的链上交易被确认**并不**代表结束：
要一直轮询到 `settled` 为止。

## 出问题时

读 `error.code`。最可能遇到的三个：

| `error.code` | 发生了什么 | 该怎么办 |
|---|---|---|
| `LINK_NO_LONGER_PAYABLE` | 这个链接已经被别人付过，或者已过期 | 找商家要一个新链接；不要付任何钱 |
| `EXPIRY_MARGIN` | 剩余时间太短，不足以安全完成充值、跨桥和结清 | 让订单过期，然后从第 1 步重新开始 |
| `ALREADY_SENT` | 这个订单已经记录过一次发送 | **不要**再发一次；先跑 `status.js` 并去链上核对 |

**只要已经有钱离开了你的钱包，就绝不要再付一次。** 保留好 `linkId`、
`rozoPaymentId` 和每一个交易 hash，找人来做对账。向一个一次性充值地址付第二笔款，
并不保证会被入账。

完整的错误码表在 [README.md](README.md)，面向 agent 的指令在 [SKILL.md](SKILL.md)。
