/**
 * x402 payer flows: topup, pay, balance.
 *
 * Contract (rozo-mpprouter, /v1/x402/*):
 *
 *   POST /v1/x402/keys      {}                                   -> { key }            (key returned once)
 *   POST /v1/x402/topup     { amount, token, chain }             -> one-time deposit order
 *   POST /v1/x402/sign      { accepts, budget, idempotencyKey,   -> { paymentSignature } (the PAYMENT-SIGNATURE value)
 *                             x402Version, resource }
 *   GET  /v1/x402/balance                                        -> { balanceUsd, limits, ... }
 *
 *   Authorization: Bearer <agent key> on topup, sign and balance.
 *   503 from any of them means the payer switch is off: "x402 payer not enabled yet".
 *
 * Boundary that matters for safety: the paid request (URL, body, the agent's
 * own API keys for that service) goes from THIS machine straight to the
 * seller. Rozo only ever sees the 402 `accepts` entry it is asked to sign.
 *
 * Idempotency: one `pay` run generates one idempotencyKey (or takes
 * --idempotency-key) and reuses it on every retry of /sign, so a timeout
 * after Rozo already debited the balance returns the same signature instead
 * of charging twice.
 */

import crypto from 'node:crypto';

import { SkillError, redact, redactDeep } from './lib/output.mjs';
import { USER_AGENT, redactUrl } from './lib/http.mjs';
import { assertNotBlacklisted, loadBlacklist } from './lib/blacklist.mjs';
import { readAgentKey, saveAgentKey, keyPath, KEY_ENV } from './lib/x402-key.mjs';
import {
  parseChallenge,
  selectRequirement,
  paymentHeaderName,
  paymentResponseHeaderNames,
  extractSignature,
  decodeSettlement,
  networkFamily,
  networkLabel,
  usdToAtomic,
  formatUsdc,
  resolveTopupPreset,
  maskKey,
  TOPUP_MIN_USD,
} from './lib/x402.mjs';
import { ATTRIBUTION_CLIENT } from './lib/api.mjs';

export const X402_BASE =
  process.env.ROZO_CHECKOUT_X402_BASE || 'https://apiserver.mpprouter.dev/v1/x402';

export const DISABLED_MESSAGE =
  'x402 payer not enabled yet. Rozo has not switched on x402 payments; nothing was charged. Try again later.';

/** /sign retries after the first attempt, all with the same idempotencyKey. */
export const SIGN_RETRIES = 2;
const SIGN_BACKOFF_MS = [1_000, 3_000];
const API_TIMEOUT_MS = 20_000;
const TARGET_TIMEOUT_MS = 60_000;
/** Cap on how much of a paid response we keep in --json output. */
export const MAX_BODY_CHARS = 1_000_000;

export const DEFAULT_MAX_USD = '1.00';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rozo x402 API client
// ---------------------------------------------------------------------------

/**
 * 503 codes that mean "try again with the same idempotencyKey". Every other
 * 503 (X402_PAYER_DISABLED, X402_PAYER_SHADOW, *_NOT_CONFIGURED, or no code)
 * means the payer is not switched on for you yet.
 */
export const RETRYABLE_503 = new Set(['X402_RETRY', 'X402_PAYER_MODE_CHANGED', 'X402_LEDGER_UNAVAILABLE']);

function isTransient(err) {
  if (!(err instanceof SkillError)) return false;
  if (err.code === 'HTTP_TIMEOUT' || err.code === 'HTTP_UNREACHABLE') return true;
  if (RETRYABLE_503.has(err.code)) return true;
  const status = err.details?.httpStatus;
  return status === 500 || status === 502 || status === 504 || status === 429;
}

/**
 * One call to the Rozo x402 API. Translates 503 into X402_PAYER_DISABLED.
 * The agent key goes in the Authorization header and nowhere else.
 */
export async function x402Api(method, path, { body, key, fetchImpl = globalThis.fetch, base = X402_BASE } = {}) {
  const url = `${base.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        'x-rozo-client': ATTRIBUTION_CLIENT,
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new SkillError(
      err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE',
      `${method} ${path} failed: ${redact(err?.message || String(err))}`,
      { url: redactUrl(url) },
    );
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (res.status === 503) {
    const serverCode = json?.code || json?.error?.code || null;
    if (RETRYABLE_503.has(serverCode)) {
      throw new SkillError(serverCode, redact(String(json?.error?.message || json?.message || 'Retry.')), { httpStatus: 503 });
    }
    throw new SkillError('X402_PAYER_DISABLED', DISABLED_MESSAGE, { httpStatus: 503, ...(serverCode ? { serverCode } : {}) });
  }
  if (!res.ok) {
    const code =
      json?.code ||
      json?.error?.code ||
      (typeof json?.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(json.error) ? json.error : null) ||
      `HTTP_${res.status}`;
    const message =
      json?.message || (typeof json?.error === 'string' ? json.error : json?.error?.message) || `HTTP ${res.status}`;
    throw new SkillError(code, redact(String(message)), {
      httpStatus: res.status,
      url: redactUrl(url),
      body: redactDeep(json ?? redact(String(text ?? '')).slice(0, 800)),
    });
  }
  if (json === null || typeof json !== 'object') {
    throw new SkillError('HTTP_BAD_JSON', `${method} ${path} returned a non-JSON body.`, { url: redactUrl(url) });
  }
  return json;
}

function requireKey() {
  const found = readAgentKey();
  if (!found) {
    throw new SkillError(
      'X402_NO_KEY',
      `No x402 agent key yet. Run "rozo-checkout x402 topup <usd> --with <coin>" first; ` +
        `it creates one and stores it in ${keyPath()}. Or set ${KEY_ENV}.`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// topup
// ---------------------------------------------------------------------------

function pick(obj, ...names) {
  for (const n of names) {
    const v = n.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/** Normalize the /topup response into the deposit block we print. */
export function normalizeTopup(resp) {
  return {
    orderId: pick(resp, 'orderId', 'rozoPaymentId', 'paymentId', 'id', 'order.id'),
    address: pick(resp, 'depositAddress', 'receiverAddress', 'address', 'deposit.address', 'order.receiverAddress'),
    memo: pick(resp, 'memo', 'receiverMemo', 'deposit.memo'),
    memoType: pick(resp, 'memoType', 'receiverMemoType', 'deposit.memoType'),
    lnInvoice: pick(resp, 'lnInvoice', 'invoice', 'deposit.lnInvoice'),
    amount: pick(resp, 'payAmount', 'amountToSend', 'deposit.amount', 'amount'),
    token: pick(resp, 'deposit.tokenSymbol', 'deposit.token', 'tokenSymbol', 'token'),
    chain: pick(resp, 'deposit.chainId', 'deposit.chain', 'chainId', 'chain'),
    creditUsd: pick(resp, 'creditUsd', 'credit', 'amountUsd'),
    expiresAt: pick(resp, 'expiresAt', 'deposit.expiresAt'),
    paymentLink: pick(resp, 'paymentLink', 'payUrl'),
  };
}

export async function runTopup({ amountUsd, coin }, { fetchImpl, blacklist } = {}) {
  const usd = Number(amountUsd);
  if (!/^\d+(\.\d{1,2})?$/.test(String(amountUsd ?? '').trim()) || !Number.isFinite(usd)) {
    throw new SkillError('BAD_VALUE', `"${amountUsd}" is not a USD amount like 20 or 20.50.`);
  }
  if (usd < TOPUP_MIN_USD) {
    throw new SkillError('BAD_VALUE', `Minimum topup is $${TOPUP_MIN_USD}.`);
  }
  const preset = resolveTopupPreset(coin);

  let found = readAgentKey();
  let created = null;
  if (!found) {
    const resp = await x402Api('POST', '/keys', { body: {}, fetchImpl });
    const key = pick(resp, 'key', 'agentKey', 'apiKey');
    if (typeof key !== 'string' || !key.startsWith('ak_')) {
      throw new SkillError('X402_BAD_KEY', 'Rozo did not return an agent key (expected ak_…).');
    }
    const file = saveAgentKey(key);
    found = { key, source: 'file' };
    created = { keyMasked: maskKey(key), storedAt: file };
  }

  const resp = await x402Api('POST', '/topup', {
    // {amount, token, chain} is the documented contract; `source` is the same
    // choice in create-invoice's shape, sent too because a router that reads
    // only `source` would otherwise fall back to its default coin.
    body: {
      amount: String(amountUsd).trim(),
      token: preset.token,
      chain: preset.chain,
      source: { chainId: preset.chain, tokenSymbol: preset.token },
    },
    key: found.key,
    fetchImpl,
  });
  const deposit = normalizeTopup(resp);
  // Never show a deposit for a different coin than the one asked for: paying
  // USDT on Solana into a Base USDC address loses the money.
  if (
    (deposit.chain !== null && String(deposit.chain) !== preset.chain) ||
    (deposit.token !== null && String(deposit.token).toUpperCase() !== preset.token)
  ) {
    throw new SkillError(
      'X402_TOPUP_MISMATCH',
      `Rozo returned a deposit for ${deposit.token ?? '?'} on chain ${deposit.chain ?? '?'}, not ${preset.token} on chain ${preset.chain}. Do not send anything; the address is withheld.`,
      { orderId: deposit.orderId },
    );
  }
  if (!deposit.address && !deposit.lnInvoice) {
    throw new SkillError('X402_BAD_TOPUP', 'Rozo returned a topup order without a deposit address.', {
      orderId: deposit.orderId,
    });
  }
  if (deposit.address) {
    const family = /^0x[0-9a-fA-F]{40}$/.test(deposit.address) ? 'evm' : preset.chain === '900' ? 'solana' : 'other';
    assertNotBlacklisted([{ address: deposit.address, family, role: 'topup deposit address' }], blacklist ?? loadBlacklist());
  }
  return {
    success: true,
    command: 'x402 topup',
    ...(created ? { keyCreated: created } : {}),
    key: { masked: maskKey(found.key), source: found.source },
    coin: preset.preset,
    native: Boolean(preset.native),
    requestedUsd: String(amountUsd).trim(),
    deposit,
    note: 'Send exactly once, from your own wallet. Your x402 balance is credited after the deposit confirms.',
  };
}

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

export async function runBalance({ fetchImpl } = {}) {
  const found = requireKey();
  const resp = await x402Api('GET', '/balance', { key: found.key, fetchImpl });
  return {
    success: true,
    command: 'x402 balance',
    key: { masked: maskKey(found.key), source: found.source },
    balanceUsd: pick(resp, 'balanceUsd', 'balance', 'available'),
    pendingUsd: pick(resp, 'pendingUsd', 'pending'),
    status: pick(resp, 'status'),
    mode: pick(resp, 'mode'),
    limits: pick(resp, 'limits') ?? {
      perPaymentUsd: pick(resp, 'perTxLimitUsd'),
      dailyUsd: pick(resp, 'dailyLimitUsd'),
      spentTodayUsd: pick(resp, 'spentTodayUsd'),
      payToAllowlist: pick(resp, 'payToAllowlist'),
    },
    recent: pick(resp, 'recent', 'payments', 'history'),
  };
}

// ---------------------------------------------------------------------------
// pay
// ---------------------------------------------------------------------------

/** Parse repeated "Name: value" header flags into a plain object. */
export function parseHeaderFlags(list) {
  const out = {};
  for (const raw of list ?? []) {
    const idx = String(raw).indexOf(':');
    if (idx <= 0) throw new SkillError('BAD_VALUE', `--header must look like "Name: value", got "${raw}".`);
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new SkillError('BAD_VALUE', `--header name "${name}" is not a valid HTTP header name.`);
    }
    if (/^(payment-signature|x-payment)$/i.test(name)) {
      throw new SkillError('BAD_VALUE', `--header ${name} is set by the payer; do not pass it.`);
    }
    out[name] = value;
  }
  return out;
}

async function callTarget(fetchImpl, { url, method, headers, body }, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARGET_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { 'user-agent': USER_AGENT, ...headers, ...extraHeaders },
      body: body ?? undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    throw new SkillError(
      err?.name === 'AbortError' ? 'HTTP_TIMEOUT' : 'HTTP_UNREACHABLE',
      `${method} ${redactUrl(url)} failed: ${redact(err?.message || String(err))}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function headerGetter(res) {
  return (name) => res.headers?.get?.(name) ?? null;
}

function bodyOut(text, contentType) {
  const truncated = text.length > MAX_BODY_CHARS;
  const s = truncated ? text.slice(0, MAX_BODY_CHARS) : text;
  if (/json/i.test(contentType ?? '') && !truncated) {
    try {
      return { body: JSON.parse(s), truncated };
    } catch {
      // fall through to text
    }
  }
  return { body: s, truncated };
}

/**
 * Call /sign with one idempotencyKey, retrying transient failures with the SAME
 * key. Exposed for tests.
 */
export async function signWithRetry(signBody, { key, fetchImpl, sleep = defaultSleep, retries = SIGN_RETRIES }) {
  let attempt = 0;
  for (;;) {
    try {
      const resp = await x402Api('POST', '/sign', { body: signBody, key, fetchImpl });
      return { resp, attempts: attempt + 1 };
    } catch (err) {
      if (attempt < retries && isTransient(err)) {
        await sleep(SIGN_BACKOFF_MS[attempt] ?? 3_000);
        attempt += 1;
        continue;
      }
      if (err instanceof SkillError) {
        err.details = { ...(err.details ?? {}), idempotencyKey: signBody.idempotencyKey, attempts: attempt + 1 };
      }
      throw err;
    }
  }
}

export async function runPay(
  { url, method = 'GET', headers = {}, body, maxUsd = DEFAULT_MAX_USD, prefer, idempotencyKey, dryRun = false },
  { fetchImpl = globalThis.fetch, sleep = defaultSleep, blacklist, uuid = () => crypto.randomUUID() } = {},
) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new SkillError('BAD_VALUE', `"${url}" is not a URL.`);
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new SkillError('BAD_VALUE', 'x402 pay only calls http(s) URLs.');
  }
  const budgetAtomic = usdToAtomic(maxUsd);
  const request = { url: target.toString(), method: method.toUpperCase(), headers, body };

  // 1. Unpaid request. Anything but 402 is returned as is: nothing to pay.
  const first = await callTarget(fetchImpl, request);
  if (first.res.status !== 402) {
    const { body: outBody, truncated } = bodyOut(first.text, first.res.headers.get('content-type'));
    return {
      success: first.res.ok,
      command: 'x402 pay',
      paid: false,
      status: first.res.status,
      contentType: first.res.headers.get('content-type'),
      body: outBody,
      ...(truncated ? { truncated } : {}),
      note: 'The endpoint did not ask for payment (no 402). Nothing was charged.',
    };
  }

  // 2. Parse the challenge and choose what to pay.
  const challenge = parseChallenge({ status: 402, getHeader: headerGetter(first.res), bodyText: first.text });
  const option = selectRequirement(challenge, { budgetAtomic, prefer });
  assertNotBlacklisted(
    [{ address: option.payTo, family: networkFamily(option.network), role: 'x402 payTo' }],
    blacklist ?? loadBlacklist(),
  );

  const key = idempotencyKey || uuid();
  const plan = {
    network: option.network,
    networkLabel: networkLabel(option.network),
    asset: option.asset,
    payTo: option.payTo,
    amountUsd: option.amountUsd,
    budgetUsd: formatUsdc(budgetAtomic),
    idempotencyKey: key,
  };
  if (dryRun) {
    return {
      success: true,
      command: 'x402 pay',
      paid: false,
      dryRun: true,
      x402Version: challenge.x402Version,
      plan,
      note: 'Dry run: the challenge was read and an option chosen; Rozo was not asked to sign and nothing was charged.',
    };
  }

  // 3. Ask Rozo to sign. Same idempotencyKey on every retry.
  const found = requireKey();
  const signBody = {
    x402Version: challenge.x402Version,
    // Only the seller's own declared resource, never our request URL: a query
    // string can carry the caller's credential for that seller.
    ...(challenge.resource ? { resource: challenge.resource } : {}),
    accepts: [option.requirement],
    budget: plan.budgetUsd,
    // Same cap under the name the router reads.
    maxAmountUsd: plan.budgetUsd,
    idempotencyKey: key,
  };
  const { resp: signed, attempts } = await signWithRetry(signBody, { key: found.key, fetchImpl, sleep });
  const signature = extractSignature(signed);
  if (!signature) {
    throw new SkillError('X402_BAD_SIGNATURE', 'Rozo answered /sign without a PAYMENT-SIGNATURE value.', {
      idempotencyKey: key,
    });
  }
  const named = [signed.headerName, signed.header].find((h) => typeof h === 'string' && /^[A-Za-z-]+$/.test(h));
  const headerName = named || paymentHeaderName(challenge.x402Version);

  // 4. Replay the original request with the payment header. A network failure
  //    is retried once with the SAME signature (the seller settles at most once
  //    per authorization), never with a new one.
  let replay;
  try {
    try {
      replay = await callTarget(fetchImpl, request, { [headerName]: signature });
    } catch (err) {
      if (err.code !== 'HTTP_TIMEOUT' && err.code !== 'HTTP_UNREACHABLE') throw err;
      await sleep(1_000);
      replay = await callTarget(fetchImpl, request, { [headerName]: signature });
    }
  } catch (err) {
    // Rozo has already signed (and debited). Hand back everything needed to
    // reconcile, so a rerun reuses the key instead of paying again.
    throw new SkillError(
      'X402_REPLAY_FAILED',
      `Rozo signed the payment but the paid request failed: ${redact(err?.message || String(err))}. ` +
        'The seller may or may not have settled it. Check "x402 balance", then rerun with the same --idempotency-key.',
      { idempotencyKey: key, paymentId: pick(signed, 'paymentId', 'id'), signed: true, cause: err?.code ?? null },
    );
  }

  const settlementHeader = paymentResponseHeaderNames()
    .map((n) => replay.res.headers.get(n))
    .find((v) => v);
  const settlement = settlementHeader ? decodeSettlement(settlementHeader) : null;
  const { body: outBody, truncated } = bodyOut(replay.text, replay.res.headers.get('content-type'));
  const payment = {
    ...plan,
    paymentId: pick(signed, 'paymentId', 'id'),
    signAttempts: attempts,
    settlement,
  };

  if (replay.res.status === 402) {
    let reason = null;
    try {
      reason = parseChallenge({ status: 402, getHeader: headerGetter(replay.res), bodyText: replay.text }).error;
    } catch {
      // no readable challenge on the retry; leave reason empty
    }
    throw new SkillError(
      'X402_PAYMENT_REJECTED',
      `The endpoint rejected the payment${reason ? `: ${redact(reason)}` : ''}. ` +
        'Do not retry with a new idempotency key; check "x402 balance" first.',
      { payment: redactDeep(payment) },
    );
  }

  return {
    success: replay.res.ok,
    command: 'x402 pay',
    paid: true,
    status: replay.res.status,
    contentType: replay.res.headers.get('content-type'),
    payment,
    body: outBody,
    ...(truncated ? { truncated } : {}),
    ...(replay.res.ok
      ? {}
      : {
          note:
            'The payment was signed but the endpoint did not return success. The seller may still have settled it; ' +
            'check "x402 balance" before trying again, and reuse --idempotency-key to avoid a second charge.',
        }),
  };
}
