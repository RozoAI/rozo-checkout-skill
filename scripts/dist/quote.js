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
var SUPPORTED_SOURCES = [
  { chainId: "1", chain: "Ethereum", tokens: ["USDC", "USDT"] },
  { chainId: "56", chain: "BNB Chain", tokens: ["USDC", "USDT"] },
  { chainId: "137", chain: "Polygon", tokens: ["USDC", "USDT"] },
  { chainId: "900", chain: "Solana", tokens: ["USDC", "USDT"] },
  { chainId: "8453", chain: "Base", tokens: ["USDC"] },
  { chainId: "1500", chain: "Stellar", tokens: ["USDC"] },
  { chainId: "lightning", chain: "Bitcoin Lightning", tokens: ["BTC"] }
];
function chainName(chainId) {
  return CHAIN_NAMES[String(chainId)] || CHAIN_NAMES[chainId] || `chain ${chainId}`;
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

// scripts/src/lib/guards.mjs
function normalizeDecimal(v) {
  if (v === null || v === void 0) return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return s;
  const [w, f = ""] = s.split(".");
  const frac = f.replace(/0+$/, "");
  const whole = w.replace(/^0+(?=\d)/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// scripts/src/quote.mjs
function derivePayable(snapshot, now) {
  const cb = snapshot.coinbase;
  if (!cb) {
    return { payable: false, code: "LINK_NO_LONGER_PAYABLE", reason: "No Coinbase state in the quote." };
  }
  if (snapshot.protocolVersion === "v3" && cb.status && cb.status !== "PAYMENT_SESSION_STATUS_CREATED") {
    return {
      payable: false,
      code: "LINK_NO_LONGER_PAYABLE",
      reason: `Payment Session status is ${cb.status}; only PAYMENT_SESSION_STATUS_CREATED is payable.`
    };
  }
  if (cb.usageCount !== null && cb.usageCount !== void 0) {
    const max = cb.maxUsage ?? 1;
    if (Number(cb.usageCount) >= Number(max)) {
      return {
        payable: false,
        code: "LINK_NO_LONGER_PAYABLE",
        reason: `This payment link has already been used (${cb.usageCount}/${max}).`
      };
    }
  }
  const exp = parseDeadline(cb.preApprovalExpiry);
  if (exp === null) {
    return {
      payable: false,
      code: "EXPIRY_UNPARSABLE",
      reason: "The Coinbase expiry is missing or unparsable; refusing to treat it as payable."
    };
  }
  if (exp <= now) {
    return {
      payable: false,
      code: "LINK_NO_LONGER_PAYABLE",
      reason: `This payment link expired at ${new Date(exp).toISOString()}. Ask for a fresh one.`
    };
  }
  return { payable: true, code: null, reason: null, expiryMs: exp };
}
async function main(argv) {
  const args = parseArgs(argv);
  const url = args.url || args._[0];
  if (!url || url === true) {
    usage('Required: --url "<coinbase payment link or paymentSession url/id>"');
  }
  const { linkId, kind } = extractLinkId(String(url));
  let chosenSource = null;
  if (args.chain || args.token) {
    const chainId = String(args.chain ?? "").trim();
    const tokenSymbol = String(args.token ?? "").trim().toUpperCase();
    if (!chainId || !tokenSymbol) {
      usage("--chain and --token must be given together, e.g. --chain 900 --token USDT");
    }
    if (!isSupportedSource(chainId, tokenSymbol)) {
      throw new SkillError(
        "UNSUPPORTED_SOURCE",
        `${tokenSymbol} on ${chainName(chainId)} is not a supported source.`,
        { supported: SUPPORTED_SOURCES }
      );
    }
    chosenSource = { chainId, tokenSymbol };
  }
  const now = Date.now();
  const quote = await quoteInvoice({ url: String(url) });
  const snapshot = snapshotFromQuote(quote);
  const payability = derivePayable(snapshot, now);
  const payload = {
    success: payability.payable,
    step: "quote",
    linkId: snapshot.linkId ?? linkId,
    linkKind: kind,
    protocolVersion: snapshot.protocolVersion,
    merchant: snapshot.merchant,
    invoice: {
      amount: snapshot.original,
      fiat: snapshot.fiat
    },
    // No discount on this line: the caller pays the full invoice amount.
    callerPays: snapshot.callerPays,
    discountPolicy: "none \u2014 callerPays equals the invoice amount",
    coinbase: snapshot.coinbase,
    coinbaseExpiryIso: payability.expiryMs ? new Date(payability.expiryMs).toISOString() : null,
    chosenSource,
    supportedSources: SUPPORTED_SOURCES,
    quoteReceipt: quote?.quoteReceipt ?? null,
    quoteReceiptTtlSeconds: 60,
    quoteReceiptNote: "Short-lived (~60s). create-order.js takes its own fresh quote; do not carry this over.",
    snapshot,
    nextStep: payability.payable ? "create-order.js --url <url> --chain <chainId> --token <SYMBOL>" : null
  };
  if (!payability.payable) {
    payload.error = { code: payability.code, message: payability.reason };
    emit(payload, EXIT_ERROR);
  }
  if (snapshot.callerPays && snapshot.original && normalizeDecimal(snapshot.callerPays) !== normalizeDecimal(snapshot.original)) {
    payload.warnings = [
      `callerPays (${snapshot.callerPays}) differs from the invoice amount (${snapshot.original}). This flow is supposed to charge the full invoice \u2014 do not proceed until that is explained.`
    ];
  }
  emit(payload);
}
async function run(argv = process.argv.slice(2)) {
  return main(argv);
}

// scripts/src/bin/quote.mjs
run().catch((err) => fail(err));
