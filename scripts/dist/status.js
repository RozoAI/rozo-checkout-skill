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
var EXIT_UNCONFIRMED = 3;
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
var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isRozoPaymentId(value) {
  return UUID_RE.test(String(value || "").trim());
}
function maskAddress(address) {
  const s = String(address ?? "").trim();
  if (!s) return "(none)";
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
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

// scripts/src/lib/api.mjs
var MPP_BASE = process.env.ROZO_CHECKOUT_MPP_BASE || "https://apiserver.mpprouter.dev/v1/services/rozo-agent-api";
var INTENTS_BASE = process.env.ROZO_CHECKOUT_INTENTS_BASE || "https://intentapiv4.rozo.ai/functions/v1/payment-api";
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

// scripts/src/lib/guards.mjs
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
function classifyStatus({ payment, routerState, coinbase, now = Date.now(), viewsFailed = false }) {
  const source = payment?.source || {};
  const hasTx = Boolean(source.txHash);
  const confirmed = Boolean(source.confirmedAt);
  const signal = receiptSignal(source);
  const receipt = signal.receipt;
  const moneyDetected = hasTx || confirmed || signal.money;
  const routerStatus = routerState?.status ?? null;
  const mk = (state, detail, opts = {}) => ({
    state,
    moneyDetected: Boolean(moneyDetected),
    terminal: Boolean(opts.terminal),
    escalate: Boolean(opts.escalate),
    unknown: Boolean(opts.unknown),
    detail,
    receipt,
    receiptUnparsable: signal.unparsable,
    routerStatus
  });
  if (viewsFailed || !payment?.status && !routerStatus && !coinbase) {
    return mk(
      "unknown",
      "Could not read the order state from the backend. This is NOT evidence that nothing has been paid \u2014 do not act on it.",
      { unknown: true }
    );
  }
  if (signal.unparsable) {
    return mk(
      "stuck_after_payment",
      "The order reports an amountReceived that cannot be read. Treating it as funded until a human confirms otherwise.",
      { escalate: true }
    );
  }
  if (routerStatus === "paid" || coinbase?.settled === true) {
    return mk("settled", "Coinbase invoice settled by the funder wallet.", { terminal: true });
  }
  if (routerStatus === "failed_pay_invoice" || routerStatus === "failed_insufficient_balance") {
    return mk(
      "stuck_after_payment",
      `Fulfillment failed (${routerStatus}) after the pay-in. Do not pay again \u2014 escalate for manual reconciliation.`,
      { terminal: false, escalate: true }
    );
  }
  if (moneyDetected && receipt && receipt.state === "underpaid") {
    return mk(
      "underpaid",
      "Less arrived than the order requires. Do NOT send a top-up to the same address \u2014 escalate.",
      { escalate: true }
    );
  }
  if (moneyDetected && receipt && receipt.state === "overpaid") {
    return mk("payin_detected", "More arrived than required; escalate for operator follow-up.", {
      escalate: true
    });
  }
  switch (payment?.status) {
    case "payment_unpaid": {
      if (moneyDetected) {
        return mk("payin_detected", "Pay-in seen on chain, waiting for confirmations.");
      }
      const exp = payment?.expiresAt ? Date.parse(payment.expiresAt) : NaN;
      if (Number.isFinite(exp) && exp < now) {
        return mk("expired_unfunded", "The order expired before any funds arrived. Safe to retry.", {
          terminal: true
        });
      }
      return mk("awaiting_deposit", "Waiting for the deposit.");
    }
    case "payment_started":
      return mk("payin_detected", "Pay-in seen, waiting for confirmations.");
    case "payment_payin_completed":
      return mk("payin_confirmed", "Pay-in confirmed; fulfillment can start.");
    case "payment_bridging":
    case "payment_payout_started":
      return mk("bridging", "Bridging the pay-in toward the funder.");
    case "payment_payout_completed":
      return mk(
        routerStatus === "paying" ? "paying_coinbase" : "bridging",
        routerStatus === "paying" ? "Funder is paying the Coinbase invoice." : "Payout landed; waiting on Coinbase settlement."
      );
    case "payment_completed":
      return mk(
        "paying_coinbase",
        "The bridge leg completed, but Coinbase settlement is not yet confirmed. Keep polling."
      );
    case "payment_expired":
      return moneyDetected ? mk("stuck_after_payment", "Order expired AFTER funds arrived \u2014 escalate immediately.", {
        escalate: true
      }) : mk("expired_unfunded", "Order expired unfunded. Safe to retry.", { terminal: true });
    case "payment_bounced":
    case "payment_refunded":
      return mk("stuck_after_payment", `Order ended as ${payment.status} \u2014 escalate.`, {
        escalate: true
      });
    default:
      break;
  }
  if (routerStatus === "payin_seen") return mk("payin_confirmed", "Router saw the pay-in.");
  if (routerStatus === "paying") return mk("paying_coinbase", "Funder is paying Coinbase.");
  return mk(
    moneyDetected ? "stuck_after_payment" : "unknown",
    `Unrecognized backend status "${payment?.status ?? "unknown"}"; not assuming anything about it.`,
    { escalate: Boolean(moneyDetected), unknown: !moneyDetected }
  );
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

// scripts/src/lib/state.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
function stateRoot() {
  return process.env.ROZO_CHECKOUT_STATE_DIR || path.join(os.homedir(), ".rozo-checkout", "state");
}
function findByLinkId(linkId) {
  const dir = stateRoot();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (s?.linkId !== linkId) continue;
      if (!best || String(s.createdAt) > String(best.createdAt)) best = s;
    } catch {
    }
  }
  return best;
}

// scripts/src/status.mjs
var POLL_INTERVAL_MS = 1e4;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function snapshot({ rozoPaymentId, linkId }) {
  let status = null;
  let statusError = null;
  try {
    status = await invoiceStatus({ linkId, rozoPaymentId });
  } catch (err) {
    statusError = { code: err.code, message: err.message };
  }
  let id = rozoPaymentId || status?.rozo_payment_id || null;
  let idSource = rozoPaymentId ? "argument" : status?.rozo_payment_id ? "invoice-status" : null;
  if (!id && linkId) {
    const local = findByLinkId(linkId);
    if (local) {
      id = local.rozoPaymentId;
      idSource = "local state";
    }
  }
  let payment = null;
  let paymentError = null;
  if (id && isRozoPaymentId(id)) {
    try {
      payment = await getPayment(id);
    } catch (err) {
      paymentError = { code: err.code, message: err.message };
    }
  }
  const viewsFailed = Boolean(statusError) && !payment;
  const verdict = classifyStatus({
    payment: payment || status?.rozoPayment || {},
    routerState: status?.routerState,
    coinbase: status?.coinbase,
    viewsFailed
  });
  const source = payment?.source || status?.rozoPayment?.source || {};
  return {
    rozoPaymentId: id,
    rozoPaymentIdSource: idSource,
    // Without the authoritative payment object we are reading a partial view.
    authoritativeView: Boolean(payment),
    linkId: linkId || status?.pl_id || null,
    state: verdict.state,
    unknown: verdict.unknown,
    moneyDetected: verdict.moneyDetected,
    terminal: verdict.terminal,
    escalate: verdict.escalate,
    detail: verdict.detail,
    backend: {
      paymentStatus: payment?.status ?? status?.rozoPayment?.status ?? null,
      routerStatus: verdict.routerStatus,
      coinbaseSettled: status?.coinbase?.settled ?? null,
      coinbaseStatus: status?.coinbase?.status ?? null
    },
    payin: {
      expected: source.amount ? formatAmount(source) : null,
      received: source.amountReceived ?? null,
      receipt: verdict.receipt,
      txHash: source.txHash ?? null,
      confirmedAt: source.confirmedAt ?? null,
      senderAddressMasked: source.senderAddress ? maskAddress(source.senderAddress) : null,
      chain: source.chainId ? chainName(source.chainId) : null
    },
    expiry: (() => {
      const iso = payment?.expiresAt ?? status?.rozoPayment?.expiresAt ?? null;
      if (!iso) return { expiresAt: null, expiresIn: null, msRemaining: null };
      const ms = Date.parse(iso) - Date.now();
      return {
        expiresAt: iso,
        expiresIn: formatRemaining(ms),
        msRemaining: Number.isFinite(ms) ? ms : null
      };
    })(),
    payout: {
      txHash: payment?.destination?.txHash ?? status?.rozoPayment?.destination?.txHash ?? null,
      confirmedAt: payment?.destination?.confirmedAt ?? status?.rozoPayment?.destination?.confirmedAt ?? null
    },
    errors: [statusError, paymentError].filter(Boolean)
  };
}
async function main(argv) {
  const args = parseArgs(argv);
  const rozoPaymentId = args["rozo-payment-id"] || (isRozoPaymentId(args._[0]) ? args._[0] : null);
  const linkId = args["link-id"] || (!rozoPaymentId ? args._[0] : null);
  if (!rozoPaymentId && !linkId) {
    usage("Required: --rozo-payment-id <uuid> and/or --link-id <pl_* | paymentSession_*>");
  }
  const watch = Boolean(args.watch);
  const timeoutMs = Math.max(0, Number(args.timeout ?? 600) * 1e3);
  const deadline = Date.now() + timeoutMs;
  let result = await snapshot({ rozoPaymentId, linkId });
  const history = [{ at: (/* @__PURE__ */ new Date()).toISOString(), state: result.state }];
  while (watch && !result.terminal && !result.escalate && !result.unknown && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const next = await snapshot({ rozoPaymentId: result.rozoPaymentId || rozoPaymentId, linkId });
    if (next.state !== result.state) history.push({ at: (/* @__PURE__ */ new Date()).toISOString(), state: next.state });
    result = next;
  }
  const guidance = result.escalate ? "MONEY DETECTED and the order is not on a healthy path. Do NOT pay again and do NOT create a new order for this link. Preserve linkId, rozoPaymentId and every tx hash, then escalate to the operator for manual reconciliation." : result.unknown ? "The order state could not be established. This is NOT evidence that nothing was paid \u2014 do not create a new order and do not send again on the strength of it. Retry, or pass --rozo-payment-id so the authoritative pay-in view can be read." : !result.authoritativeView ? "Only the fulfilment view was readable; the pay-in view is unavailable, so the money-detected rule cannot be enforced. Pass --rozo-payment-id for a complete answer." : result.state === "expired_unfunded" ? "Nothing was funded, so nothing was lost. Start a fresh order with: rozo-checkout pay <coinbase-link> --with <coin>  (or create-order.js --url <link> --chain <id> --token <SYMBOL>)" : result.terminal ? "Done." : "Still in flight. Poll again in ~10s.";
  const unresolved = watch && !result.terminal && !result.escalate && !result.unknown;
  const failed = result.escalate || result.unknown || !result.authoritativeView;
  emit(
    {
      success: !failed,
      step: "status",
      ...result,
      history,
      guidance,
      timedOut: unresolved
    },
    failed ? EXIT_ERROR : unresolved ? EXIT_UNCONFIRMED : 0
  );
}
async function run(argv = process.argv.slice(2)) {
  return main(argv);
}

// scripts/src/bin/status.mjs
run().catch((err) => fail(err));
