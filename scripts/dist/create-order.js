#!/usr/bin/env node
import { createRequire as __rozoCreateRequire } from 'node:module';
import { fileURLToPath as __rozoFileURLToPath } from 'node:url';
import { dirname as __rozoDirname } from 'node:path';
const require = __rozoCreateRequire(import.meta.url);
const __filename = __rozoFileURLToPath(import.meta.url);
const __dirname = __rozoDirname(__filename);

// scripts/src/lib/output.mjs
var EXIT_OK = 0;
var EXIT_ERROR = 1;
var EXIT_USAGE = 2;
function redact(text) {
  if (text === null || text === void 0) return text;
  let s = typeof text === "string" ? text : String(text);
  s = s.replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>");
  s = s.replace(/\b[0-9a-fA-F]{64}\b/g, "<redacted>");
  s = s.replace(/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, "<redacted>");
  s = s.replace(/\[(?:\s*\d{1,3}\s*,){40,}\s*\d{1,3}\s*\]/g, "[<redacted>]");
  s = s.replace(/\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s"'<>]+)/g, (_m, scheme, rest) => {
    const withoutUserinfo = rest.includes("@") ? rest.slice(rest.indexOf("@") + 1) : rest;
    const host = withoutUserinfo.split(/[/?#]/)[0];
    const hadMore = withoutUserinfo.length > host.length;
    return `${scheme}://${host}${hadMore ? "/<redacted>" : ""}`;
  });
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>");
  s = s.replace(
    /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|secret|token|password|passwd|pwd)\b(\s*[:=]\s*)("?)[A-Za-z0-9._~+/=-]{6,}\3/gi,
    "$1$2<redacted>"
  );
  return s;
}
function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/priv(ate)?[-_]?key|secret|mnemonic|seed/i.test(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}
var capturing = false;
var EmitSignal = class extends Error {
  constructor(payload, exitCode) {
    super("emit");
    this.payload = payload;
    this.exitCode = exitCode;
  }
};
function formatFailure(err, fallbackCode = "RUNTIME_ERROR") {
  const code = err && err.code || fallbackCode;
  const message = redact(err && err.message || String(err));
  const payload = { success: false, error: { code, message } };
  if (err && err.details) payload.error.details = redactDeep(err.details);
  return payload;
}
function emit(payload, exitCode = EXIT_OK) {
  const redacted = redactDeep(payload);
  if (capturing) throw new EmitSignal(redacted, exitCode);
  process.stdout.write(JSON.stringify(redacted, null, 2) + "\n");
  process.exit(exitCode);
}
function fail(err, fallbackCode = "RUNTIME_ERROR", exitCode = EXIT_ERROR) {
  const payload = formatFailure(err, fallbackCode);
  if (capturing) throw new EmitSignal(payload, exitCode);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(exitCode);
}
function usage(message) {
  fail({ code: "USAGE", message }, "USAGE", EXIT_USAGE);
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === void 0 || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
var SkillError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
};

// scripts/src/lib/ids.mjs
var IdError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var PL_RE = /(pl_[0-9a-zA-Z]+)/;
var SESSION_RE = /(paymentSession_[A-Za-z0-9_-]+)/;
var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function extractLinkId(urlOrId) {
  if (typeof urlOrId !== "string" || !urlOrId.trim()) {
    throw new IdError("BAD_LINK", "A Coinbase payment link URL or id is required.");
  }
  const s = urlOrId.trim();
  const session = s.match(SESSION_RE);
  if (session) return { linkId: session[1], kind: "payment_session" };
  const link = s.match(PL_RE);
  if (link) return { linkId: link[1], kind: "payment_link" };
  if (/commerce\.coinbase\.com\/pay\//.test(s)) {
    throw new IdError(
      "LEGACY_COMMERCE_URL",
      "commerce.coinbase.com/pay/<uuid> uses the legacy protocol; this skill does not handle it."
    );
  }
  throw new IdError(
    "BAD_LINK",
    "Could not find a `pl_*` or `paymentSession_*` id in the supplied value."
  );
}
function assertRozoPaymentId(value) {
  const s = String(value || "").trim();
  if (!UUID_RE.test(s)) {
    throw new IdError("BAD_ROZO_PAYMENT_ID", "rozoPaymentId must be a UUID.");
  }
  return s;
}
function maskAddress(address) {
  const s = String(address ?? "").trim();
  if (!s) return "(none)";
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}
function maskMemo(memo) {
  const s = String(memo ?? "").trim();
  if (!s) return null;
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}...${s.slice(-3)}`;
}

// scripts/src/lib/http.mjs
var DEFAULT_TIMEOUT_MS = 2e4;
var USER_AGENT = "rozo-checkout-skill/1.0";
async function request(method, url, { body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...body !== void 0 ? { "content-type": "application/json" } : {}
      },
      body: body !== void 0 ? JSON.stringify(body) : void 0,
      signal: controller.signal
    });
  } catch (err) {
    throw new SkillError(
      err?.name === "AbortError" ? "HTTP_TIMEOUT" : "HTTP_UNREACHABLE",
      `${method} request failed: ${redact(err?.message || String(err))}`,
      { url: redactUrl(url) }
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const code = json?.code || json?.error?.code || (typeof json?.error === "string" ? null : null) || `HTTP_${res.status}`;
    const message = json?.message || (typeof json?.error === "string" ? json.error : json?.error?.message) || `HTTP ${res.status}`;
    throw new SkillError(code, redact(String(message)), {
      httpStatus: res.status,
      url: redactUrl(url),
      body: json ?? redact(text).slice(0, 800)
    });
  }
  if (json === null) {
    throw new SkillError("HTTP_BAD_JSON", "Endpoint returned a non-JSON body.", {
      url: redactUrl(url),
      snippet: redact(text).slice(0, 400)
    });
  }
  return json;
}
function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url);
  }
}
function getJson(url, opts) {
  return request("GET", url, opts);
}
function postJson(url, body, opts) {
  return request("POST", url, { ...opts, body });
}

// scripts/src/lib/api.mjs
var MPP_BASE = process.env.ROZO_CHECKOUT_MPP_BASE || "https://apiserver.mpprouter.dev/v1/services/rozo-agent-api";
var INTENTS_BASE = process.env.ROZO_CHECKOUT_INTENTS_BASE || "https://intentapiv4.rozo.ai/functions/v1/payment-api";
async function quoteInvoice({ url, linkId }) {
  const body = url ? { url } : { payment_id: linkId };
  return postJson(`${MPP_BASE}/quote-invoice`, body);
}
async function createInvoice({ url, linkId, source, quoteReceipt }) {
  const body = {
    ...url ? { url } : { payment_id: linkId },
    source: { chainId: String(source.chainId), tokenSymbol: source.tokenSymbol },
    ...quoteReceipt ? { quoteReceipt } : {}
  };
  return postJson(`${MPP_BASE}/create-invoice`, body);
}
async function invoiceStatus({ linkId, rozoPaymentId }) {
  const qs = new URLSearchParams();
  if (linkId) qs.set("payment_id", linkId);
  if (rozoPaymentId) qs.set("rozo_payment_id", rozoPaymentId);
  if (![...qs.keys()].length) {
    throw new SkillError("USAGE", "invoiceStatus needs linkId or rozoPaymentId.");
  }
  return getJson(`${MPP_BASE}/invoice-status?${qs.toString()}`);
}
async function getPayment(rozoPaymentId) {
  return getJson(`${INTENTS_BASE}/payments/${encodeURIComponent(rozoPaymentId)}`);
}
function snapshotFromQuote(quote) {
  const cb = quote?.coinbasePayment || quote?.paymentLink || null;
  return {
    linkId: quote?.linkId ?? quote?.paymentId ?? null,
    protocolVersion: quote?.protocolVersion ?? null,
    merchant: quote?.merchant ?? null,
    original: quote?.invoice?.amount ?? null,
    callerPays: quote?.quote?.callerPays ?? null,
    fiat: quote?.invoice?.fiat ?? null,
    coinbase: cb ? {
      id: cb.id ?? null,
      status: cb.status ?? null,
      usageCount: cb.usageCount ?? null,
      maxUsage: cb.maxUsage ?? null,
      preApprovalExpiry: cb.preApprovalExpiry ?? cb.expiresAt ?? null
    } : null
  };
}

// scripts/src/lib/amounts.mjs
var CHAIN_NAMES = {
  1: "Ethereum",
  56: "BNB Chain",
  137: "Polygon",
  8453: "Base",
  900: "Solana",
  1500: "Stellar",
  lightning: "Bitcoin Lightning"
};
var CHAIN_FAMILY = {
  1: "evm",
  56: "evm",
  137: "evm",
  8453: "evm",
  900: "solana",
  1500: "stellar",
  lightning: "lightning"
};
var SUPPORTED_SOURCES = [
  { chainId: "1", chain: "Ethereum", tokens: ["USDC", "USDT"] },
  { chainId: "56", chain: "BNB Chain", tokens: ["USDC", "USDT"] },
  { chainId: "137", chain: "Polygon", tokens: ["USDC", "USDT"] },
  { chainId: "900", chain: "Solana", tokens: ["USDC", "USDT"] },
  { chainId: "8453", chain: "Base", tokens: ["USDC"] },
  { chainId: "1500", chain: "Stellar", tokens: ["USDC"] },
  { chainId: "lightning", chain: "Bitcoin Lightning", tokens: ["BTC"] }
];
var DECIMALS = {
  "1:USDC": 6,
  "1:USDT": 6,
  // BNB Chain: BEP-20 USDT and USDC are both 18-decimals.
  "56:USDC": 18,
  "56:USDT": 18,
  "137:USDC": 6,
  "137:USDT": 6,
  "8453:USDC": 6,
  "900:USDC": 6,
  "900:USDT": 6,
  // Stellar classic assets carry 7 decimal places.
  "1500:USDC": 7
};
var AmountError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function decimalsKey(chainId, tokenSymbol) {
  return `${String(chainId).trim()}:${String(tokenSymbol || "").trim().toUpperCase()}`;
}
function decimalsFor(chainId, tokenSymbol) {
  const key = decimalsKey(chainId, tokenSymbol);
  const d = DECIMALS[key];
  if (d === void 0) {
    throw new AmountError(
      "UNKNOWN_DECIMALS",
      `No decimals known for ${key}; refusing to guess.`
    );
  }
  return d;
}
function isSatsUnit(amountUnit) {
  return String(amountUnit || "").trim().toLowerCase() === "sats";
}
function toAtomic(decimalString, decimals) {
  if (typeof decimalString === "number") decimalString = String(decimalString);
  if (typeof decimalString !== "string") {
    throw new AmountError("BAD_AMOUNT", "Amount must be a string or number.");
  }
  const s = decimalString.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new AmountError("BAD_AMOUNT", `Not a plain decimal amount: ${s}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AmountError("BAD_DECIMALS", `Invalid decimals: ${decimals}`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    const excess = frac.slice(decimals);
    if (/[^0]/.test(excess)) {
      throw new AmountError(
        "AMOUNT_PRECISION",
        `Amount ${s} has more precision than ${decimals} decimals allow.`
      );
    }
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + (decimals > 0 ? padded : ""));
}
function satsToAtomic(value) {
  const s = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+$/.test(s)) {
    throw new AmountError("BAD_SATS", `Lightning amount must be integer sats: ${s}`);
  }
  return BigInt(s);
}
function sourceAtomic(source, field) {
  const raw = source?.[field];
  if (raw === null || raw === void 0 || raw === "") return null;
  if (isSatsUnit(source?.amountUnit)) return satsToAtomic(raw);
  return toAtomic(raw, decimalsFor(source?.chainId, source?.tokenSymbol));
}
function comparePayment(source) {
  const expected = sourceAtomic(source, "amount");
  if (expected === null) {
    throw new AmountError("MISSING_EXPECTED_AMOUNT", "source.amount is missing.");
  }
  const received = sourceAtomic(source, "amountReceived");
  if (received === null || received === 0n) {
    return {
      state: "none",
      expectedAtomic: expected.toString(),
      receivedAtomic: (received ?? 0n).toString(),
      deltaAtomic: (0n - expected).toString()
    };
  }
  const delta = received - expected;
  return {
    state: delta === 0n ? "exact" : delta < 0n ? "underpaid" : "overpaid",
    expectedAtomic: expected.toString(),
    receivedAtomic: received.toString(),
    deltaAtomic: delta.toString()
  };
}
function formatAmount(source) {
  const amount = source?.amount;
  if (isSatsUnit(source?.amountUnit)) return `${amount} sats`;
  return `${amount} ${source?.tokenSymbol ?? ""}`.trim();
}
function chainName(chainId) {
  return CHAIN_NAMES[String(chainId)] || CHAIN_NAMES[chainId] || `chain ${chainId}`;
}
var STELLAR_MEMO_TYPE = "MEMO_TEXT";
function chainFamily(chainId) {
  return CHAIN_FAMILY[String(chainId)] || CHAIN_FAMILY[chainId] || null;
}
function isSupportedSource(chainId, tokenSymbol) {
  const cid = String(chainId).trim();
  const sym = String(tokenSymbol || "").trim().toUpperCase();
  return SUPPORTED_SOURCES.some((s) => s.chainId === cid && s.tokens.includes(sym));
}

// scripts/src/lib/expiry.mjs
var MINUTE = 6e4;
var MARGINS_MS = {
  1: 10 * MINUTE,
  56: 10 * MINUTE,
  137: 10 * MINUTE,
  8453: 10 * MINUTE,
  900: 5 * MINUTE,
  1500: 10 * MINUTE,
  lightning: 10 * MINUTE
};
var BOLT11_MIN_VALIDITY_MS = 10 * MINUTE;
var DEFAULT_MARGIN_MS = 10 * MINUTE;
function formatRemaining(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 6e4);
  if (totalMinutes < 1) return `${Math.floor(ms / 1e3)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function marginFor(chainId) {
  const key = String(chainId);
  return MARGINS_MS[key] ?? MARGINS_MS[chainId] ?? DEFAULT_MARGIN_MS;
}
function parseDeadline(value) {
  if (value === null || value === void 0 || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1e3) : Math.round(value);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1e3 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
function checkExpiry({
  now,
  chainId,
  intentExpiresAt,
  coinbaseExpiry,
  bolt11ExpiresAt = void 0
}) {
  const marginMs = marginFor(chainId);
  const intentMs = parseDeadline(intentExpiresAt);
  const coinbaseMs = parseDeadline(coinbaseExpiry);
  const bolt11Ms = bolt11ExpiresAt === void 0 ? void 0 : parseDeadline(bolt11ExpiresAt);
  const deadlines = { intentMs, coinbaseMs, bolt11Ms: bolt11Ms ?? null };
  const base = {
    marginMs,
    effectiveDeadlineMs: null,
    msRemaining: null,
    msOfSlack: null,
    deadlines
  };
  if (intentMs === null) {
    return {
      ...base,
      ok: false,
      code: "EXPIRY_UNPARSABLE",
      reason: "Intent expiresAt is missing or unparsable."
    };
  }
  if (coinbaseMs === null) {
    return {
      ...base,
      ok: false,
      code: "EXPIRY_UNPARSABLE",
      reason: "Coinbase preApprovalExpiry is missing or unparsable."
    };
  }
  const effective = Math.min(intentMs, coinbaseMs);
  const msRemaining = effective - now;
  const msOfSlack = msRemaining - marginMs;
  const withDeadline = {
    ...base,
    effectiveDeadlineMs: effective,
    msRemaining,
    msOfSlack
  };
  if (msRemaining <= 0) {
    return {
      ...withDeadline,
      ok: false,
      code: "EXPIRED",
      reason: "The order or the Coinbase link has already expired."
    };
  }
  if (msOfSlack <= 0) {
    return {
      ...withDeadline,
      ok: false,
      code: "EXPIRY_MARGIN",
      reason: `Only ${Math.floor(msRemaining / 1e3)}s left before the earliest deadline; this chain needs a ${Math.floor(marginMs / 6e4)} min safety margin.`
    };
  }
  if (bolt11ExpiresAt !== void 0) {
    if (bolt11Ms === null) {
      return {
        ...withDeadline,
        ok: false,
        code: "EXPIRY_UNPARSABLE",
        reason: "BOLT11 invoice expiry is missing or unparsable."
      };
    }
    const bolt11Remaining = bolt11Ms - now;
    if (bolt11Remaining < BOLT11_MIN_VALIDITY_MS) {
      return {
        ...withDeadline,
        ok: false,
        code: "BOLT11_TOO_SHORT",
        reason: `BOLT11 invoice has ${Math.max(0, Math.floor(bolt11Remaining / 1e3))}s of validity left; at least 10 min is required. Request a fresh invoice.`
      };
    }
  }
  return { ...withDeadline, ok: true, code: null, reason: null };
}

// scripts/src/lib/guards.mjs
var UNPAID_STATUS = "payment_unpaid";
function receiptSignal(source) {
  const raw = source?.amountReceived;
  if (raw === null || raw === void 0 || raw === "") {
    return { money: false, receipt: null, unparsable: false };
  }
  try {
    const receipt = comparePayment(source);
    return { money: receipt.state !== "none", receipt, unparsable: false };
  } catch {
    return { money: true, receipt: null, unparsable: true };
  }
}
function validateDepositInstructions(source) {
  const family = chainFamily(source?.chainId);
  const address = typeof source?.receiverAddress === "string" ? source.receiverAddress.trim() : "";
  const memo = typeof source?.receiverMemo === "string" ? source.receiverMemo.trim() : "";
  const bolt11 = typeof source?.lnInvoice === "string" && source.lnInvoice.trim() ? source.lnInvoice.trim() : "";
  let amountAtomic;
  try {
    amountAtomic = sourceAtomic(source, "amount");
  } catch (err) {
    return {
      ok: false,
      code: "DEPOSIT_INCOMPLETE",
      reason: `The deposit amount is unusable: ${err.message}`
    };
  }
  if (amountAtomic === null || amountAtomic <= 0n) {
    return {
      ok: false,
      code: "DEPOSIT_INCOMPLETE",
      reason: "The order carries no positive deposit amount."
    };
  }
  if (family === "lightning") {
    if (!bolt11) {
      return {
        ok: false,
        code: "DEPOSIT_INCOMPLETE",
        reason: "The Lightning order has no BOLT11 invoice yet (the swap may still be being created). Nothing is payable until it appears."
      };
    }
    return { ok: true, code: null, reason: null, family, amountAtomic, payTo: bolt11, memo: null };
  }
  if (!address) {
    return {
      ok: false,
      code: "DEPOSIT_NOT_LIVE",
      reason: "The live payments response returned no deposit address."
    };
  }
  if (family === "stellar" && !memo) {
    return {
      ok: false,
      code: "DEPOSIT_MEMO_REQUIRED",
      reason: "A Stellar deposit requires a memo, and this order did not supply one. Sending without it would very likely lose the funds. Refusing to display it as payable."
    };
  }
  return {
    ok: true,
    code: null,
    reason: null,
    family,
    amountAtomic,
    payTo: address,
    memo: memo || null
  };
}
function reuseGuard({ payment, requested, reused = false }) {
  const source = payment?.source || {};
  const evidence = {
    reused: Boolean(reused),
    status: payment?.status ?? null,
    txHash: source.txHash ?? null,
    amountReceived: source.amountReceived ?? null,
    confirmedAt: source.confirmedAt ?? null,
    chainId: source.chainId ?? null,
    tokenSymbol: source.tokenSymbol ?? null,
    senderAddress: source.senderAddress ?? null
  };
  const hasTx = source.txHash !== null && source.txHash !== void 0 && source.txHash !== "";
  const signal = receiptSignal(source);
  const hasConfirm = source.confirmedAt !== null && source.confirmedAt !== void 0 && source.confirmedAt !== "";
  if (hasTx || signal.money || hasConfirm) {
    return {
      ok: false,
      code: "ORDER_ALREADY_FUNDED",
      reason: signal.unparsable ? "This order reports an amountReceived that cannot be read. It is treated as funded until a human confirms otherwise \u2014 do NOT pay again." : "This Coinbase link already has a funded Rozo order (it may have been paid elsewhere). Do NOT pay again \u2014 escalate for manual reconciliation.",
      moneyDetected: true,
      evidence: { ...evidence, receipt: signal.receipt, receiptUnparsable: signal.unparsable }
    };
  }
  if (payment?.status !== UNPAID_STATUS) {
    const terminal = ["payment_expired", "payment_bounced", "payment_refunded"].includes(
      payment?.status
    );
    return {
      ok: false,
      code: terminal ? "ORDER_NOT_PAYABLE" : "ORDER_ALREADY_FUNDED",
      reason: `Existing order status is "${payment?.status ?? "unknown"}", not "${UNPAID_STATUS}".`,
      moneyDetected: !terminal,
      evidence
    };
  }
  const wantChain = String(requested?.chainId ?? "").trim();
  const wantToken = String(requested?.tokenSymbol ?? "").trim().toUpperCase();
  const gotChain = String(source.chainId ?? "").trim();
  const gotToken = String(source.tokenSymbol ?? "").trim().toUpperCase();
  if (!gotChain || !gotToken || gotChain !== wantChain || gotToken !== wantToken) {
    return {
      ok: false,
      code: "REUSED_SOURCE_MISMATCH",
      reason: `The order expects ${gotToken || "?"} on chain ${gotChain || "?"}, but you chose ${wantToken} on chain ${wantChain}. Paying the wrong asset or network is usually unrecoverable.`,
      moneyDetected: false,
      evidence
    };
  }
  const deposit = validateDepositInstructions(source);
  if (!deposit.ok) {
    return {
      ok: false,
      code: deposit.code,
      reason: deposit.reason,
      moneyDetected: false,
      evidence
    };
  }
  return { ok: true, code: null, reason: null, moneyDetected: false, evidence, deposit };
}
function verifyCreateAgainstQuote({ snapshot, created, requested }) {
  const drift = [];
  const require2 = (field, a, b, normalize = defaultNormalize) => {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === null) {
      drift.push({ field, quoted: null, created: nb, note: "missing in quote" });
      return;
    }
    if (nb === null) {
      drift.push({ field, quoted: na, created: null, note: "missing in create response" });
      return;
    }
    if (na !== nb) drift.push({ field, quoted: na, created: nb });
  };
  require2("linkId", snapshot?.linkId, created?.linkId);
  require2("merchant", snapshot?.merchant, created?.merchant, normalizeMerchant);
  require2("original", snapshot?.original, created?.original, normalizeDecimal);
  require2("callerPays", snapshot?.callerPays, created?.callerPays, normalizeDecimal);
  const wantChain = String(requested?.chainId ?? "").trim();
  const wantToken = String(requested?.tokenSymbol ?? "").trim().toUpperCase();
  const gotChain = String(created?.source?.chainId ?? "").trim();
  const gotToken = String(created?.source?.tokenSymbol ?? "").trim().toUpperCase();
  if (!gotChain || gotChain !== wantChain) {
    drift.push({ field: "source.chainId", quoted: wantChain, created: gotChain || null });
  }
  if (!gotToken || gotToken !== wantToken) {
    drift.push({ field: "source.tokenSymbol", quoted: wantToken, created: gotToken || null });
  }
  if (drift.length) {
    return {
      ok: false,
      code: "CREATE_DRIFT",
      reason: "The created order does not match what was quoted. Refusing to continue.",
      drift
    };
  }
  const disc = created?.discount;
  if (disc !== void 0 && disc !== null && normalizeDecimal(disc) !== "0") {
    return {
      ok: false,
      code: "NO_DISCOUNT_VIOLATION",
      reason: `Server reported a discount of "${disc}"; this flow must charge the full invoice.`,
      drift: [{ field: "discount", quoted: "0", created: String(disc) }]
    };
  }
  if (created?.callerPays !== void 0 && created?.original !== void 0 && normalizeDecimal(created.callerPays) !== normalizeDecimal(created.original)) {
    return {
      ok: false,
      code: "NO_DISCOUNT_VIOLATION",
      reason: `callerPays (${created.callerPays}) differs from the invoice amount (${created.original}).`,
      drift: [
        { field: "callerPays", quoted: String(created.original), created: String(created.callerPays) }
      ]
    };
  }
  return { ok: true, code: null, reason: null, drift: [] };
}
function defaultNormalize(v) {
  if (v === null || v === void 0) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function normalizeMerchant(v) {
  if (v === null || v === void 0) return null;
  if (typeof v === "object") {
    const name = v.name ?? v.merchantName ?? null;
    return name ? String(name).trim() || null : null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}
function normalizeDecimal(v) {
  if (v === null || v === void 0) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const [w, f = ""] = s.split(".");
  const frac = f.replace(/0+$/, "");
  const whole = w.replace(/^0+(?=\d)/, "");
  return frac ? `${whole}.${frac}` : whole;
}
function checkPayable(statusResponse, now = Date.now()) {
  const cb = statusResponse?.coinbase;
  if (!cb) {
    return {
      ok: false,
      code: "LINK_NO_LONGER_PAYABLE",
      reason: "invoice-status returned no Coinbase state; cannot prove the link is still payable.",
      derived: null
    };
  }
  const protocolVersion = cb.protocolVersion ?? statusResponse?.protocolVersion ?? null;
  const derived = {
    protocolVersion,
    status: cb.status ?? null,
    settled: cb.settled ?? null,
    usageCount: cb.usageCount ?? null,
    maxUsage: cb.maxUsage ?? null,
    preApprovalExpiry: cb.preApprovalExpiry ?? null
  };
  if (cb.settled === true) {
    return {
      ok: false,
      code: "LINK_NO_LONGER_PAYABLE",
      reason: "The Coinbase resource is already settled \u2014 someone has paid it.",
      derived
    };
  }
  if (protocolVersion === "v3") {
    if (!cb.status) {
      return {
        ok: false,
        code: "LINK_PAYABILITY_UNKNOWN",
        reason: "The Payment Session response carries no status; cannot prove it is still payable.",
        derived
      };
    }
    if (cb.status !== "PAYMENT_SESSION_STATUS_CREATED") {
      return {
        ok: false,
        code: "LINK_NO_LONGER_PAYABLE",
        reason: `Payment Session status is ${cb.status}; only PAYMENT_SESSION_STATUS_CREATED is payable.`,
        derived
      };
    }
    return { ok: true, code: null, reason: null, derived };
  }
  const usage2 = Number(cb.usageCount);
  const max = Number(cb.maxUsage);
  if (cb.usageCount === null || cb.usageCount === void 0 || cb.maxUsage === null || cb.maxUsage === void 0 || !Number.isFinite(usage2) || !Number.isFinite(max)) {
    return {
      ok: false,
      code: "LINK_PAYABILITY_UNKNOWN",
      reason: "The payment link response is missing usageCount/maxUsage; cannot prove it has not already been used.",
      derived
    };
  }
  if (usage2 >= max) {
    return {
      ok: false,
      code: "LINK_NO_LONGER_PAYABLE",
      reason: `Payment link already used (${usage2}/${max}).`,
      derived
    };
  }
  return { ok: true, code: null, reason: null, derived };
}

// scripts/src/lib/blacklist.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
var BlacklistError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function normalizeAddress(address, family) {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (family === "evm" || /^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}
function parseBlacklist(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Blacklist document is not an object.");
  }
  const { provenance, entries } = doc;
  if (!provenance || typeof provenance !== "object") {
    throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Blacklist provenance header is missing.");
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Blacklist is empty or not an array.");
  }
  const addresses = [];
  for (const e of entries) {
    if (!e || typeof e !== "object" || typeof e.address !== "string" || !e.address.trim()) {
      throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Blacklist entry has no address.");
    }
    addresses.push(e.address);
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(addresses), "utf8").digest("hex");
  if (typeof provenance.addressesSha256 !== "string" || !provenance.addressesSha256) {
    throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Blacklist provenance digest is missing.");
  }
  if (digest !== provenance.addressesSha256) {
    throw new BlacklistError(
      "BLACKLIST_UNAVAILABLE",
      "Blacklist digest mismatch \u2014 the vendored address list was modified without re-signing."
    );
  }
  if (provenance.addressCount !== void 0 && provenance.addressCount !== entries.length) {
    throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Blacklist addressCount does not match entries.");
  }
  const index = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const key = normalizeAddress(e.address, e.family);
    if (key) index.set(key, e);
    const lower = e.address.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(lower)) index.set(lower, e);
  }
  return { entries, index, provenance, digest };
}
function candidatePaths(moduleUrl) {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.join(here, "blacklist.json"),
    path.join(here, "..", "src", "lib", "blacklist.json"),
    path.join(here, "..", "..", "src", "lib", "blacklist.json")
  ];
}
var cached = null;
function loadBlacklist(explicitPath) {
  if (!explicitPath && cached) return cached;
  const paths = explicitPath ? [explicitPath] : candidatePaths(import.meta.url);
  let lastErr = null;
  for (const p of paths) {
    let raw;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch (err) {
      lastErr = err;
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new BlacklistError("BLACKLIST_UNAVAILABLE", `Blacklist file is not valid JSON: ${p}`);
    }
    const parsed = parseBlacklist(doc);
    parsed.sourceFile = p;
    if (!explicitPath) cached = parsed;
    return parsed;
  }
  throw new BlacklistError(
    "BLACKLIST_UNAVAILABLE",
    `Blacklist file not found (looked in ${paths.length} locations). Refusing to proceed.` + (lastErr ? ` Last error: ${lastErr.code || lastErr.message}` : "")
  );
}
function checkAddress(address, family, blacklist) {
  const bl = blacklist || loadBlacklist();
  const normalized = normalizeAddress(address, family);
  if (!normalized) {
    throw new BlacklistError("BLACKLIST_UNAVAILABLE", "Cannot check an empty address.");
  }
  const entry = bl.index.get(normalized) || bl.index.get(normalized.toLowerCase()) || null;
  return { hit: Boolean(entry), entry, normalized };
}
function assertNotBlacklisted(targets, blacklist) {
  const bl = blacklist || loadBlacklist();
  for (const t of targets) {
    if (!t || !t.address) continue;
    const { hit, entry } = checkAddress(t.address, t.family, bl);
    if (hit) {
      const err = new BlacklistError(
        "BLACKLIST_HIT",
        `${t.role || "address"} is on the compromised-wallet blacklist (reported ${entry.reportedOn}: ${entry.note}). Refusing.`
      );
      err.role = t.role || "address";
      throw err;
    }
  }
  return true;
}

// scripts/src/lib/state.mjs
import fs2 from "node:fs";
import path2 from "node:path";
import os from "node:os";
import crypto2 from "node:crypto";
var LOCK_STALE_MS = 6e4;
var LOCK_WAIT_MS = 1e4;
var LOCK_POLL_MS = 25;
function lockPath() {
  return path2.join(stateRoot(), ".send.lock");
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function tryAcquire(file) {
  try {
    const fd = fs2.openSync(file, "wx", 384);
    fs2.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
    fs2.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return false;
  }
}
function withLock(fn) {
  const file = lockPath();
  fs2.mkdirSync(path2.dirname(file), { recursive: true, mode: 448 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (; ; ) {
    if (tryAcquire(file)) break;
    try {
      const age = Date.now() - fs2.statSync(file).mtimeMs;
      if (age > LOCK_STALE_MS) {
        const stolen = `${file}.stale.${crypto2.randomBytes(4).toString("hex")}`;
        try {
          fs2.renameSync(file, stolen);
          fs2.unlinkSync(stolen);
        } catch {
        }
        continue;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      continue;
    }
    if (Date.now() > deadline) {
      throw new SkillError(
        "LOCK_TIMEOUT",
        "Another rozo-checkout process is holding the send lock. Refusing to proceed rather than risk a concurrent second send."
      );
    }
    sleepSync(LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      fs2.unlinkSync(file);
    } catch {
    }
  }
}
function stateRoot() {
  return process.env.ROZO_CHECKOUT_STATE_DIR || path2.join(os.homedir(), ".rozo-checkout", "state");
}
function statePath(rozoPaymentId) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(rozoPaymentId || ""))) {
    throw new SkillError("BAD_ROZO_PAYMENT_ID", "Refusing to build a state path from that id.");
  }
  return path2.join(stateRoot(), `${rozoPaymentId}.json`);
}
function writeAtomic(file, data) {
  const dir = path2.dirname(file);
  fs2.mkdirSync(dir, { recursive: true, mode: 448 });
  const tmp = path2.join(dir, `.${path2.basename(file)}.${crypto2.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs2.openSync(tmp, "wx", 384);
  try {
    fs2.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs2.fsyncSync(fd);
  } finally {
    fs2.closeSync(fd);
  }
  fs2.renameSync(tmp, file);
}
function readState(rozoPaymentId) {
  const file = statePath(rozoPaymentId);
  let raw;
  try {
    raw = fs2.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new SkillError("STATE_UNREADABLE", `Cannot read local state: ${err.code}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SkillError(
      "STATE_CORRUPT",
      "The local state file for this order is corrupt. Refusing to act; inspect it manually."
    );
  }
}
function createOrderRecord(record) {
  return withLock(() => createOrderRecordUnlocked(record));
}
function createOrderRecordUnlocked(record) {
  const { rozoPaymentId } = record;
  const existing = readState(rozoPaymentId);
  const next = {
    version: 1,
    rozoPaymentId,
    linkId: record.linkId,
    paymentLink: record.paymentLink ?? null,
    merchant: record.merchant ?? null,
    invoiceAmount: record.invoiceAmount ?? null,
    source: record.source,
    receiverAddress: record.receiverAddress,
    receiverMemo: record.receiverMemo ?? null,
    amount: record.amount,
    amountUnit: record.amountUnit ?? null,
    expiresAt: record.expiresAt ?? null,
    createdAt: existing?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    confirmation: existing?.confirmation ?? null,
    send: existing?.send ?? null
  };
  writeAtomic(statePath(rozoPaymentId), next);
  return next;
}
function depositDigest(source) {
  const canonical = JSON.stringify({
    chainId: String(source?.chainId ?? ""),
    tokenSymbol: String(source?.tokenSymbol ?? "").toUpperCase(),
    tokenAddress: String(source?.tokenAddress ?? ""),
    receiverAddress: String(source?.receiverAddress ?? ""),
    receiverMemo: source?.receiverMemo ?? null,
    amount: String(source?.amount ?? ""),
    amountUnit: source?.amountUnit ?? null,
    lnInvoice: source?.lnInvoice ?? null
  });
  return crypto2.createHash("sha256").update(canonical, "utf8").digest("hex");
}
function recordConfirmation(rozoPaymentId, { source, invoiceAmount, tier }) {
  return withLock(() => {
    const state = readState(rozoPaymentId);
    if (!state) {
      throw new SkillError("NO_ORDER_STATE", "Cannot confirm an order with no local record.");
    }
    const next = {
      ...state,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      confirmation: {
        confirmedAt: (/* @__PURE__ */ new Date()).toISOString(),
        depositDigest: depositDigest(source),
        invoiceAmount: invoiceAmount ?? state.invoiceAmount ?? null,
        tier: tier ?? null
      }
    };
    writeAtomic(statePath(rozoPaymentId), next);
    return next;
  });
}

// scripts/src/create-order.mjs
function confirmTier(usdAmount) {
  const usd = Number(usdAmount);
  if (!Number.isFinite(usd)) return "explicit";
  if (usd <= 1) return "silent";
  if (usd <= 10) return "one-line";
  return "explicit";
}
async function main(argv) {
  const args = parseArgs(argv);
  const url = args.url || args._[0];
  if (!url || url === true) usage('Required: --url "<coinbase payment link url or id>"');
  const chainId = String(args.chain ?? "").trim();
  const tokenSymbol = String(args.token ?? "").trim().toUpperCase();
  if (!chainId || !tokenSymbol) {
    usage("Required: --chain <chainId> --token <SYMBOL>. Run quote.js to see supported sources.");
  }
  if (!isSupportedSource(chainId, tokenSymbol)) {
    throw new SkillError(
      "UNSUPPORTED_SOURCE",
      `${tokenSymbol} on ${chainName(chainId)} is not a supported source.`,
      { supported: SUPPORTED_SOURCES }
    );
  }
  const requested = { chainId, tokenSymbol };
  const confirmed = Boolean(args.confirm);
  let blacklist;
  try {
    blacklist = loadBlacklist();
  } catch (err) {
    throw new SkillError(
      "BLACKLIST_UNAVAILABLE",
      `Compromised-address list unusable: ${err.message} Refusing to proceed.`
    );
  }
  const { linkId: parsedLinkId } = extractLinkId(String(url));
  const quote = await quoteInvoice({ url: String(url) });
  const snapshot = snapshotFromQuote(quote);
  const quoteReceipt = quote?.quoteReceipt ?? null;
  const created = await createInvoice({
    url: String(url),
    source: requested,
    quoteReceipt
  });
  if (!created?.rozoPaymentId) {
    throw new SkillError("CREATE_FAILED", "create-invoice returned no rozoPaymentId.", {
      response: created
    });
  }
  const rozoPaymentId = assertRozoPaymentId(created.rozoPaymentId);
  const verify = verifyCreateAgainstQuote({ snapshot, created, requested });
  if (!verify.ok) {
    const onlySourceDrift = verify.drift.length > 0 && verify.drift.every((d) => d.field.startsWith("source."));
    if (created.reused && onlySourceDrift) {
      const existing = created.source || {};
      const remainingMs = created.expiresAt ? Date.parse(created.expiresAt) - Date.now() : NaN;
      emit(
        {
          success: false,
          step: "reuse-source-mismatch",
          error: {
            code: "REUSED_SOURCE_MISMATCH",
            message: `This link already has an unpaid order, created for ${existing.tokenSymbol ?? "?"} on chain ${existing.chainId ?? "?"}. You asked for ${tokenSymbol} on chain ${chainId}. Only one order exists per link at a time, so nothing new was created.`
          },
          linkId: created.linkId ?? parsedLinkId,
          rozoPaymentId,
          paymentLink: created.paymentLink ?? null,
          existingOrder: {
            rozoPaymentId,
            chainId: existing.chainId ?? null,
            tokenSymbol: existing.tokenSymbol ?? null,
            expiresAt: created.expiresAt ?? null,
            expiresIn: Number.isFinite(remainingMs) ? formatRemaining(remainingMs) : null
          },
          guidance: `Either pay the existing order with ${existing.tokenSymbol ?? "its own coin"} (re-run with --chain ${existing.chainId} --token ${existing.tokenSymbol}), or wait ${Number.isFinite(remainingMs) ? formatRemaining(remainingMs) : "for it to expire"} for it to expire and then create a new one. Unpaid orders cost nothing.`
        },
        EXIT_ERROR
      );
    }
    emit(
      {
        success: false,
        step: "verify-create",
        error: { code: verify.code, message: verify.reason, details: { drift: verify.drift } },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        paymentLink: created.paymentLink ?? null,
        guidance: "The order exists but was NOT validated. Do not fund it. Let it expire unfunded."
      },
      EXIT_ERROR
    );
  }
  const payment = await getPayment(rozoPaymentId);
  const source = payment?.source || {};
  const guard = reuseGuard({ payment, requested, reused: created.reused });
  if (!guard.ok) {
    emit(
      {
        success: false,
        step: "reuse-guard",
        error: { code: guard.code, message: guard.reason, details: guard.evidence },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        paymentLink: created.paymentLink ?? null,
        moneyDetected: guard.moneyDetected,
        guidance: guard.moneyDetected ? "MONEY DETECTED. Do not pay again, do not retry into a new order. Preserve every id and tx hash above and escalate to the operator for manual reconciliation." : "Abort this run. Nothing was funded."
      },
      EXIT_ERROR
    );
  }
  const lightning = String(source.chainId) === "lightning";
  const bolt11 = source.lnInvoice ?? payment?.lnInvoice ?? null;
  const expiry = checkExpiry({
    now: Date.now(),
    chainId: source.chainId ?? chainId,
    intentExpiresAt: payment?.expiresAt,
    coinbaseExpiry: snapshot?.coinbase?.preApprovalExpiry,
    // For Lightning the BOLT11's own validity is an extra gate. We only have a
    // separate expiry if the backend exposes one; otherwise the intent expiry
    // governs and we still require the 10-minute floor via the margin.
    ...lightning ? { bolt11ExpiresAt: payment?.expiresAt } : {}
  });
  if (!expiry.ok) {
    emit(
      {
        success: false,
        step: "expiry-guard",
        error: { code: expiry.code, message: expiry.reason, details: expiry },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        guidance: "Not enough time remains to fund, bridge and settle safely. Ask the merchant for a fresh link and start over. Do not fund this order."
      },
      EXIT_ERROR
    );
  }
  try {
    assertNotBlacklisted(
      [
        {
          address: source.receiverAddress,
          family: chainFamily(source.chainId),
          role: "deposit address"
        }
      ],
      blacklist
    );
  } catch (err) {
    emit(
      {
        success: false,
        step: "blacklist",
        error: { code: err.code, message: err.message },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        guidance: "Do NOT send anything. Report this to the operator immediately."
      },
      EXIT_ERROR
    );
  }
  const statusNow = await invoiceStatus({ linkId: created.linkId ?? parsedLinkId });
  const payable = checkPayable(statusNow, Date.now());
  if (!payable.ok) {
    emit(
      {
        success: false,
        step: "payability-revalidation",
        error: { code: payable.code, message: payable.reason, details: payable.derived },
        linkId: created.linkId ?? parsedLinkId,
        rozoPaymentId,
        guidance: "The Coinbase resource stopped being payable between quote and now (someone else may have paid it). Do NOT fund this order."
      },
      EXIT_ERROR
    );
  }
  createOrderRecord({
    rozoPaymentId,
    linkId: created.linkId ?? parsedLinkId,
    paymentLink: created.paymentLink ?? null,
    merchant: created.merchant ?? snapshot.merchant,
    invoiceAmount: created.original ?? snapshot.original,
    source: { chainId: source.chainId, tokenSymbol: source.tokenSymbol },
    receiverAddress: source.receiverAddress,
    receiverMemo: source.receiverMemo ?? null,
    amount: source.amount,
    amountUnit: source.amountUnit ?? null,
    expiresAt: payment?.expiresAt ?? null
  });
  const usd = created.original ?? snapshot.original;
  const family = chainFamily(source.chainId);
  const tier = confirmTier(usd);
  const depositInfo = guard.deposit;
  if (confirmed) {
    recordConfirmation(rozoPaymentId, { source, invoiceAmount: usd, tier });
  }
  const memoRequirement = lightning ? "Lightning invoices carry their own routing data; there is no separate memo." : source.receiverMemo ? "This deposit REQUIRES the memo/tag below. Sending without it will very likely lose the funds." : family === "stellar" ? "A Stellar deposit always requires a memo." : "This deposit does not use a memo. Leave the memo field empty.";
  emit({
    success: true,
    step: "create-order",
    confirmed,
    reused: Boolean(created.reused),
    reusedNote: created.reused ? `An existing unpaid order for this link was reused (${rozoPaymentId}), valid for another ${formatRemaining(expiry.msRemaining)}. Nothing new was created.` : null,
    orderCost: "Creating an order moves no money. An order you never fund simply expires and costs nothing.",
    linkId: created.linkId ?? parsedLinkId,
    rozoPaymentId,
    paymentLink: created.paymentLink ?? null,
    merchant: normalizeMerchant(created.merchant ?? snapshot.merchant),
    invoice: { amount: usd, currency: snapshot?.fiat?.currency ?? "USD" },
    callerPays: created.callerPays ?? snapshot.callerPays,
    discount: created.discount ?? "0",
    // Machine-readable, copy-pastable — and WITHHELD until --confirm. This is
    // the only place the full address, memo and BOLT11 ever appear.
    deposit: confirmed ? {
      chainId: source.chainId,
      chain: chainName(source.chainId),
      tokenSymbol: source.tokenSymbol,
      tokenAddress: source.tokenAddress || null,
      // Lightning has no deposit address: the BOLT11 IS the instruction.
      receiverAddress: lightning ? null : source.receiverAddress,
      receiverMemo: source.receiverMemo ?? null,
      // Stellar memos are TEXT even when they look numeric. Sending one as
      // MEMO_ID produces a different memo and the payment will not match.
      receiverMemoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
      amount: source.amount,
      amountUnit: source.amountUnit ?? null,
      isSats: isSatsUnit(source.amountUnit),
      lnInvoice: bolt11 || null,
      payTo: depositInfo.payTo,
      expiresAt: payment?.expiresAt ?? null,
      expiresIn: formatRemaining(expiry.msRemaining)
    } : null,
    depositWithheld: !confirmed,
    // Safe for prose / chat.
    display: {
      chain: chainName(source.chainId),
      token: source.tokenSymbol,
      amount: formatAmount(source),
      isSats: isSatsUnit(source.amountUnit),
      payToMasked: maskAddress(depositInfo.payTo),
      receiverMemoMasked: maskMemo(source.receiverMemo),
      hasMemo: Boolean(source.receiverMemo),
      memoType: source.receiverMemo ? STELLAR_MEMO_TYPE : null,
      memoRequirement
    },
    expiry: {
      intentExpiresAt: payment?.expiresAt ?? null,
      coinbaseExpiry: snapshot?.coinbase?.preApprovalExpiry ?? null,
      effectiveDeadlineIso: new Date(expiry.effectiveDeadlineMs).toISOString(),
      // A duration, not just a timestamp: this is what a payer actually needs.
      expiresIn: formatRemaining(expiry.msRemaining),
      msRemaining: expiry.msRemaining,
      marginMinutes: Math.round(expiry.marginMs / 6e4),
      minutesOfSlack: Math.floor(expiry.msOfSlack / 6e4)
    },
    confirmation: {
      required: tier,
      satisfied: confirmed,
      note: confirmed ? "Confirmation recorded. The send scripts will verify it against the live deposit data." : "BINDING CONFIRMATION POINT. Present chain, token, exact amount, the masked address, the memo requirement, both expiries and the reused flag, and get an explicit yes. Then re-run this command with --confirm to release the full deposit details.",
      warnings: [
        "Wrong token, wrong network, or wrong amount is usually unrecoverable.",
        memoRequirement,
        "Send exactly once. A second send to the same one-time address is not guaranteed to be credited.",
        "The deposit amount can exceed the invoice: it includes the bridge and network fees."
      ]
    },
    blacklist: {
      checked: true,
      addressesInList: blacklist.entries.length,
      digest: blacklist.provenance.addressesSha256
    },
    nextStep: confirmed ? {
      modeA: "Give the user the `deposit` block, then poll: status.js --rozo-payment-id <id>",
      modeB: family === "evm" ? `send-evm.js --rozo-payment-id ${rozoPaymentId} --send  (requires ROZO_CHECKOUT_EVM_KEY)` : family === "solana" ? `send-sol.js --rozo-payment-id ${rozoPaymentId} --send  (requires ROZO_CHECKOUT_SOL_KEY)` : "not available for this chain \u2014 pay from a wallet (Mode A)"
    } : {
      confirm: "Re-run this exact command with --confirm once the user has said yes."
    }
  });
}
async function run(argv = process.argv.slice(2)) {
  return main(argv);
}

// scripts/src/bin/create-order.mjs
run().catch((err) => fail(err));
