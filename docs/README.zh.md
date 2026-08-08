# rozo-checkout

[English](../README.md) | **简体中文** | [日本語](README.ja.md) | [Español](README.es.md)

用一种 **OpenRouter Coinbase 收款链接 (Payment Link)** 本身收不了的币去付款 —— 走
闪电网络的 BTC，或者 Solana、BNB Chain、Ethereum、Polygon、Base、Stellar 上的
USDT/USDC。Coinbase 收款链接只接受 Base 上的 USDC；本工具把你实际持有的币通过
一座桥路由过去，再由一个出资钱包代你结清账单。无需账号、无需 API key、无需浏览器。

```bash
npx @rozoai/checkout pay <coinbase-link>
```

它会先问你想用哪种币付款 —— 在提示处粘贴你的钱包地址，它就会标出哪些币你余额
够付 —— 然后打印一个充值地址，你用任意钱包付进去即可 —— **不需要私钥、不需要
环境变量、不需要任何配置**。之后它会一直等到账单被结清。

已经知道要用哪种币？直接跳过这一问：

```bash
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

## 可用于付款的币种

| 链 | `--with` | 链 id | 备注 |
|---|---|---|---|
| Ethereum | `usdt-ethereum` `usdc-ethereum` | `1` | 6 位小数 |
| BNB Chain | `usdt-bnb` `usdc-bnb` | `56` | 18 位小数 |
| Polygon | `usdt-polygon` `usdc-polygon` | `137` | 6 位小数 |
| Base | `usdc-base` | `8453` | 6 位小数 |
| Solana | `usdt-solana` `usdc-solana` | `900` | SPL；不支持原生 SOL |
| Stellar | `usdc-stellar` | `1500` | 必须带 memo —— 会在充值信息块里给出 |
| Bitcoin Lightning | `btc-lightning` | `lightning` | BOLT11；金额单位为聪 |

原生 gas 币（SOL、BNB、ETH、MATIC）以及链上 BTC 均不接受。

## 在你的 agent 里使用

不管用哪个 agent，喂给它的东西都一样：上面那条命令，或者直接让它读
[llms.txt](../llms.txt)。**用你自己的钱包付款永远不需要私钥。** 只有可选的
`--send` 才会在本地签名，也只有它会读取 `ROZO_CHECKOUT_EVM_KEY` /
`ROZO_CHECKOUT_SOL_KEY`。

<details>
<summary><b>Claude Code</b> —— 安装 skill，或者直接粘贴那条命令</summary>

本仓库本身就是一个 Claude Code skill：它自带 `SKILL.md` 和 `scripts/dist/` 里的
可执行文件。把它克隆到你的 skills 目录，Claude Code 会自动识别。

```bash
git clone https://github.com/RozoAI/rozo-checkout-skill ~/.claude/skills/rozo-checkout
```

或者跳过安装，直接让它执行：

```
用 Solana 上的 USDT 支付这个 OpenRouter 链接：
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。只有当你想让 Claude 用热钱包签名时才加 `--send`，
那一步才需要环境变量里的私钥。
</details>

<details>
<summary><b>Codex CLI</b> —— 写进 AGENTS.md，或者直接跑</summary>

Codex 会读取项目根目录的 `AGENTS.md`。加一条常驻指令，它就不用每次都被告知怎么付：

```
要支付 OpenRouter / Coinbase 收款链接，执行：
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>OpenCode</b> —— 写进 AGENTS.md，或者直接跑</summary>

OpenCode 同样读取项目根目录的 `AGENTS.md`，所以上面那段 Codex 的写法可以原样照搬。
最短的路径依然是直接执行命令本身：

```bash
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>Cline</b> —— 写进 .clinerules，或者直接跑</summary>

Cline 从项目根目录的 `.clinerules` 读取常驻指令：

```
要支付 OpenRouter / Coinbase 收款链接，执行：
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>Cursor</b> —— 写进 .cursor/rules，或者直接跑</summary>

在 `.cursor/rules/rozo-checkout.mdc` 加一条项目规则：

```
要支付 OpenRouter / Coinbase 收款链接，执行：
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>Hermes Agent</b> —— 在会话里跑那条命令</summary>

Hermes Agent（Nous Research）有 shell 权限，也有自己的 skill 体系。用 `hermes`
启动后这样说：

```
先抓取 https://checkout.rozo.ai/llms.txt，然后支付这个 OpenRouter 链接：
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>OpenClaw</b> —— openclaw agent exec</summary>

OpenClaw 的无头入口用来跑一次性任务，很适合从脚本或聊天渠道里触发一笔付款：

```bash
openclaw agent exec "Pay this OpenRouter link with USDT on Solana by running: npx @rozoai/checkout pay <coinbase-link> --with usdt-solana"
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>Pi</b> —— 在会话里跑那条命令</summary>

Pi 是一个 BYOK 终端 agent，内置工具里就有 `bash`，可以直接执行命令。用 `pi`
启动后这样说：

```
用 Solana 上的 USDT 支付这个 OpenRouter 链接，执行：
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

<details>
<summary><b>终端 —— 完全不用 agent</b> —— 一步步跑脚本</summary>

每一步都自己来。打包产物是自包含的，除了 Node 18+ 之外不需要装任何东西。

```bash
git clone https://github.com/RozoAI/rozo-checkout-skill && cd rozo-checkout-skill
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"

# 只读报价，不产生任何费用
node scripts/dist/quote.js --url "$LINK"

# 创建订单。此阶段完整充值地址会被扣留：你先拿到一份打码后的摘要用于核对。
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT

# 决定付款之后，加 --confirm 重新执行同一条命令来释放它
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm

# 用任意钱包按充值信息块付款，然后观察它结清
node scripts/dist/status.js --rozo-payment-id <uuid> --watch
```

每个脚本在 stdout 上只打印一个 JSON 对象。退出码 `0` 表示成功，`1` 表示被拒绝/
失败（读 `error.code`），`2` 表示用法错误，`3` 表示已提交但未确认。完整走一遍：
[QUICKSTART](QUICKSTART.zh.md)。

钱包：任意钱包，**无需私钥**。热钱包发送见 `send-evm.js` / `send-sol.js`，它们读取
`ROZO_CHECKOUT_EVM_KEY` / `ROZO_CHECKOUT_SOL_KEY`。agent 和脚本必须显式传 `--with`：
交互式选择只在终端里出现，而且刻意没有默认币种。
</details>

<details>
<summary><b>任何其他 agent</b> —— 让它去读 llms.txt</summary>

只要一个 agent 能抓 URL、能执行命令，它就能干这件事：

```
把 https://checkout.rozo.ai/llms.txt 抓进你的上下文，然后照着它
支付这个 OpenRouter 链接：<coinbase-link>
```

如果 agent 没有 shell 但能发 HTTP 请求，它可以直接调用那四个公开端点 —— 见
[工作原理](how-it-works.md)。

钱包：任意钱包，**无需私钥**。`--send` 才需要环境变量里的私钥。
</details>

## 三条必须知道的规则

- **充值地址是一次性的。** 绝不要复用旧订单、缓存响应或截图里的地址。
- **严格按显示的金额发送。** 它通常比账单金额大 —— 因为包含了跨桥费和网络费。
- **绝不要对已入账的订单二次付款。** 一旦检测到已有付款，就停下来找人工核对；
  再往一个一次性地址打第二笔钱，不保证能被记账。

它拒绝去做哪些事、以及为什么，完整清单见
[docs/safety.md](safety.md)。

## 相关链接

- [快速开始](QUICKSTART.zh.md) —— 五条命令，附预期输出
- [工作原理](how-it-works.md) —— 流程、端点、标识符
- [安全设计](safety.md) —— 每一道防线的细节
- [SKILL.md](../SKILL.md) —— 面向 agent 的指令 · [llms.txt](../llms.txt) —— 单文件摘要
- [checkout.rozo.ai/agent](https://checkout.rozo.ai/agent.html) —— 网页版，同样的东西
- [Issues](https://github.com/RozoAI/rozo-checkout-skill/issues) —— bug 与需求

## 更新日志

- **0.1.1** —— 两条额度上限合并为一条：单笔付款不得超过 $1,100（按购买 $1,000
  额度加 5% 手续费来设定），单会话累计上限与 `--yes-large` 绕过开关均已移除。文档
  明确说明：用你自己的钱包付款不需要私钥，也不需要任何配置。
- **0.1.0** —— 首个版本：`npx @rozoai/checkout`。

## 许可证

MIT。
