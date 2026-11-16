/**
 * Agent Checkout (beta) CLI: env gate, credential file handling, idempotency
 * key reuse and router error mapping, against a local mock router. Nothing
 * leaves 127.0.0.1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_CLI = path.join(here, '..', 'scripts', 'src', 'cli.mjs');
const DIST_CLI = path.join(here, '..', 'scripts', 'dist', 'cli.js');

const CREDENTIAL = `ac_live_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0WXY'}`; // 43 chars after prefix
const BIND_CODE = `acbind_live_${'Zz9Yy8Xx7Ww6Vv5Uu4Tt3S'}`; // 22 chars
const FINGERPRINT = 'ac_0123456789ab';
const LINK = 'https://payments.coinbase.com/payment-links/pl_01testlinkagentcheckout';

// ---------------------------------------------------------------------------
// Mock router
// ---------------------------------------------------------------------------

const mock = { routes: {}, calls: [] };
function resetMock() {
  mock.routes = {};
  mock.calls = [];
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
    mock.calls.push({ key, headers: req.headers, body: body ? JSON.parse(body) : null });
    const route = mock.routes[key];
    const r = typeof route === 'function' ? route(req, body) : route;
    if (!r) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', messageKey: 'agent_checkout.not_found' } }));
      return;
    }
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/v1/agent-checkout`;
test.after(() => server.close());

const err = (status, code, extra = {}) => ({ status, body: { error: { code, messageKey: `agent_checkout.${code.toLowerCase()}`, ...extra } } });

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-ac-home-'));
  return { home, stateDir: path.join(home, '.rozo-checkout', 'state') };
}

function runCli(args, { box, gate = true, input, cli = SRC_CLI } = {}) {
  const env = { ...process.env, HOME: box.home, USERPROFILE: box.home, ROZO_CHECKOUT_STATE_DIR: box.stateDir, ROZO_CHECKOUT_AC_BASE: BASE, NO_COLOR: '1', ROZO_CHECKOUT_ANON_ID: 'off' };
  if (gate) env.ROZO_AGENT_CHECKOUT_BETA = '1';
  else delete env.ROZO_AGENT_CHECKOUT_BETA;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [cli, ...args], { cwd: box.home, env }, (e, stdout, stderr) => {
      resolve({ code: e ? e.code ?? 1 : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const credFile = (box) => path.join(box.home, '.rozo-checkout', 'agent-checkout-credential');

function writeCred(box, mode = 0o600, record = { version: 1, credential: CREDENTIAL, fingerprint: FINGERPRINT }) {
  const dir = path.dirname(credFile(box));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credFile(box), JSON.stringify(record), { mode });
  fs.chmodSync(credFile(box), mode);
}

const claimOk = { status: 201, body: { bindRequestId: '11111111-2222-4333-8444-555555555555', credential: CREDENTIAL, fingerprint: FINGERPRINT, status: 'claimed', confirmExpiresAt: '2026-11-17T12:00:00Z' } };

const requestView = (over = {}) => ({
  spendRequestId: 'sr_0123456789abcdef',
  displayRef: 'AC-7K2Q',
  status: 'pending_approval',
  provider: 'coinbase',
  invoiceId: 'pl_01testlinkagentcheckout',
  merchantDisplay: 'OpenRouter',
  merchantVerified: true,
  invoiceAmount: '10.00',
  invoiceCurrency: 'USD',
  feeAtomic: '150000',
  totalDebitAtomic: '10150000',
  ...over,
});

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

test('gate off: every command prints one line, exits non-zero, makes no network call', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/bind-requests/claim'] = claimOk;
  const box = sandbox();
  for (const cmd of [['bind', BIND_CODE], ['binding-status'], ['request', LINK, '--context', 'x'], ['request-status', 'sr_0123456789abcdef']]) {
    const r = await runCli(cmd, { box, gate: false });
    assert.notEqual(r.code, 0, cmd[0]);
    assert.equal(r.stdout.trim(), 'Agent Checkout is not available yet.');
    assert.equal(r.stdout.trim().split('\n').length, 1);
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(fs.existsSync(credFile(box)), false);
});

test('gate off on the built bundle too; help lists the commands only when the gate is on', async () => {
  const box = sandbox();
  const off = await runCli(['bind', '-'], { box, gate: false, cli: DIST_CLI, input: BIND_CODE });
  assert.notEqual(off.code, 0);
  assert.match(off.stdout, /not available yet/);
  const helpOff = await runCli(['--help'], { box, gate: false });
  assert.doesNotMatch(helpOff.stdout, /binding-status|request-status|Agent Checkout|AGENT CHECKOUT/i);
  const helpOn = await runCli(['--help'], { box, gate: true });
  assert.match(helpOn.stdout, /binding-status/);
  assert.match(helpOn.stdout, /request-status/);
});

test('gate value must be exactly 1', async () => {
  const { gateOn } = await import('../scripts/src/lib/agent-checkout.mjs');
  assert.equal(gateOn({ ROZO_AGENT_CHECKOUT_BETA: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(gateOn({ ROZO_AGENT_CHECKOUT_BETA: v }), false);
});

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

test('bind from stdin: file 0600 in a 0700 dir, only the masked credential is printed', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/bind-requests/claim'] = claimOk;
  const box = sandbox();
  const r = await runCli(['bind', '-', '--name', 'my agent'], { box, input: `${BIND_CODE}\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].body, { bindCode: BIND_CODE, displayName: 'my agent' });
  assert.equal(mock.calls[0].headers.authorization, undefined);

  const st = fs.statSync(credFile(box));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(credFile(box))).mode & 0o777, 0o700);
  const rec = JSON.parse(fs.readFileSync(credFile(box), 'utf8'));
  assert.equal(rec.credential, CREDENTIAL);
  assert.equal(rec.fingerprint, FINGERPRINT);
  // no temp files left behind
  assert.deepEqual(fs.readdirSync(path.dirname(credFile(box))).filter((f) => f.endsWith('.tmp')), []);

  for (const text of [r.stdout, r.stderr]) {
    assert.equal(text.includes(CREDENTIAL), false);
    assert.equal(text.includes(CREDENTIAL.slice(8, 30)), false);
    assert.equal(text.includes(BIND_CODE), false);
  }
  assert.match(r.stdout, /ac_live_…WXY|ac_live_…0WXY/);
  assert.match(r.stdout, new RegExp(FINGERPRINT));
  assert.match(r.stdout, /confirm this agent in Discord/);
});

test('bind --json never carries the full credential', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/bind-requests/claim'] = claimOk;
  const box = sandbox();
  const r = await runCli(['bind', '--json'], { box, input: BIND_CODE });
  assert.equal(r.code, 0, r.stdout);
  const p = JSON.parse(r.stdout);
  assert.equal(p.credentialMasked, `ac_live_…${CREDENTIAL.slice(-4)}`);
  assert.equal(p.fingerprint, FINGERPRINT);
  assert.equal(r.stdout.includes(CREDENTIAL), false);
});

test('bind refuses to overwrite without --force and makes no claim; --force replaces', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/bind-requests/claim'] = claimOk;
  const box = sandbox();
  writeCred(box);
  const before = fs.readFileSync(credFile(box), 'utf8');
  const r = await runCli(['bind', '-', '--json'], { box, input: BIND_CODE });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).error.code, 'CREDENTIAL_EXISTS');
  assert.equal(mock.calls.length, 0);
  assert.equal(fs.readFileSync(credFile(box), 'utf8'), before);

  const f = await runCli(['bind', '-', '--force', '--json'], { box, input: BIND_CODE });
  assert.equal(f.code, 0, f.stdout);
  assert.equal(mock.calls.length, 1);
  assert.equal(fs.statSync(credFile(box)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(credFile(box), 'utf8')).claimedAt !== undefined, true);
});

test('bind rejects a malformed code locally and maps BIND_CODE_INVALID from the router', async () => {
  resetMock();
  const box = sandbox();
  const bad = await runCli(['bind', '-', '--json'], { box, input: 'not-a-code' });
  assert.equal(JSON.parse(bad.stdout).error.code, 'BIND_CODE_INVALID');
  assert.equal(mock.calls.length, 0);

  mock.routes['POST /v1/agent-checkout/bind-requests/claim'] = err(400, 'BIND_CODE_INVALID');
  const r = await runCli(['bind', '-', '--json'], { box, input: BIND_CODE });
  const p = JSON.parse(r.stdout);
  assert.equal(p.error.code, 'BIND_CODE_INVALID');
  assert.equal(r.stdout.includes(BIND_CODE), false);
  assert.equal(fs.existsSync(credFile(box)), false);
});

test('bind refuses a router credential in an unexpected format and saves nothing', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/bind-requests/claim'] = { status: 201, body: { ...claimOk.body, credential: 'ac_live_short' } };
  const box = sandbox();
  const r = await runCli(['bind', '-', '--json'], { box, input: BIND_CODE });
  assert.equal(JSON.parse(r.stdout).error.code, 'CREDENTIAL_INVALID');
  assert.equal(fs.existsSync(credFile(box)), false);
});

// ---------------------------------------------------------------------------
// Credential file read
// ---------------------------------------------------------------------------

test('credential file wider than 0600 is refused before any network call', async () => {
  resetMock();
  mock.routes['GET /v1/agent-checkout/binding'] = { status: 200, body: { status: 'active', fingerprint: FINGERPRINT } };
  const box = sandbox();
  for (const mode of [0o644, 0o640, 0o604]) {
    writeCred(box, mode);
    const r = await runCli(['binding-status', '--json'], { box });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).error.code, 'CREDENTIAL_FILE_PERMISSIONS');
  }
  assert.equal(mock.calls.length, 0);
});

test('credential file with a bad format is refused; a missing one says NOT_BOUND', async () => {
  resetMock();
  const box = sandbox();
  const missing = await runCli(['binding-status', '--json'], { box });
  assert.equal(JSON.parse(missing.stdout).error.code, 'NOT_BOUND');
  writeCred(box, 0o600, { credential: 'ac_live_tooShort' });
  const bad = await runCli(['binding-status', '--json'], { box });
  assert.equal(JSON.parse(bad.stdout).error.code, 'CREDENTIAL_FILE_INVALID');
  fs.writeFileSync(credFile(box), 'not json');
  const notJson = await runCli(['binding-status', '--json'], { box });
  assert.equal(JSON.parse(notJson.stdout).error.code, 'CREDENTIAL_FILE_INVALID');
  assert.equal(mock.calls.length, 0);
});

test('binding-status sends the bearer credential and prints only the masked form', async () => {
  resetMock();
  mock.routes['GET /v1/agent-checkout/binding'] = { status: 200, body: { status: 'pending_confirm', fingerprint: FINGERPRINT } };
  const box = sandbox();
  writeCred(box);
  const r = await runCli(['binding-status'], { box });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(mock.calls[0].headers.authorization, `Bearer ${CREDENTIAL}`);
  assert.match(r.stdout, /pending_confirm/);
  assert.match(r.stdout, /confirm this agent in Discord/);
  assert.equal(r.stdout.includes(CREDENTIAL), false);
});

// ---------------------------------------------------------------------------
// request / request-status
// ---------------------------------------------------------------------------

test('request: generated idempotency key is persisted per invoice and reused on rerun', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/requests'] = (req) => ({
    status: mock.calls.length > 1 ? 200 : 201,
    body: { replay: mock.calls.length > 1, request: requestView() },
  });
  const box = sandbox();
  writeCred(box);
  const args = ['request', LINK, '--context', 'Top up OpenRouter for the nightly eval run', '--funding', 'auto', '--json'];
  const a = JSON.parse((await runCli(args, { box })).stdout);
  const b = JSON.parse((await runCli(args, { box })).stdout);
  assert.equal(a.success, true);
  assert.match(a.idempotencyKey, /^cli_[0-9a-f-]{36}$/);
  assert.equal(a.idempotencyKeyGenerated, true);
  assert.equal(b.idempotencyKey, a.idempotencyKey);
  assert.equal(b.idempotencyKeyReused, true);
  assert.equal(b.replay, true);
  assert.equal(mock.calls[0].headers['idempotency-key'], a.idempotencyKey);
  assert.equal(mock.calls[1].headers['idempotency-key'], a.idempotencyKey);
  assert.equal(mock.calls[0].headers.authorization, `Bearer ${CREDENTIAL}`);
  assert.deepEqual(mock.calls[0].body, {
    invoice: LINK,
    context: 'Top up OpenRouter for the nightly eval run',
    entry: 'cli',
    fundingPreference: 'auto',
  });
  assert.equal(a.request.feeUsdc, '0.15');
  assert.equal(a.request.totalDebitUsdc, '10.15');
  assert.match(a.note, /Nothing is paid until your owner approves/);

  const saved = JSON.parse(fs.readFileSync(path.join(box.stateDir, 'agent-checkout', 'pl_01testlinkagentcheckout.json'), 'utf8'));
  assert.equal(saved.idempotencyKey, a.idempotencyKey);
  assert.equal(saved.spendRequestId, 'sr_0123456789abcdef');

  // A bare id maps to the same invoice and the same key.
  const c = JSON.parse((await runCli(['request', 'pl_01testlinkagentcheckout', '--context', 'Top up OpenRouter for the nightly eval run', '--funding', 'auto', '--json'], { box })).stdout);
  assert.equal(c.idempotencyKey, a.idempotencyKey);

  // An explicit key wins and is printed back.
  const d = JSON.parse((await runCli([...args, '--idempotency-key', 'my-key-12345'], { box })).stdout);
  assert.equal(d.idempotencyKey, 'my-key-12345');
  assert.equal(mock.calls.at(-1).headers['idempotency-key'], 'my-key-12345');
});

test('request 202: tells the agent to rerun the same command later', async () => {
  resetMock();
  mock.routes['POST /v1/agent-checkout/requests'] = { status: 202, body: { replay: false, request: requestView({ status: 'created' }), quoteError: 'QUOTE_UNAVAILABLE' } };
  const box = sandbox();
  writeCred(box);
  const r = await runCli(['request', LINK, '--context', 'why'], { box });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /Rerun this same command later/);
  assert.match(r.stdout, /Nothing is paid until your owner approves/);
  assert.match(r.stdout, /Idempotency key cli_/);
});

test('request validates input locally: Coinbase links only, context required', async () => {
  resetMock();
  const box = sandbox();
  writeCred(box);
  const noCtx = await runCli(['request', LINK, '--json'], { box });
  assert.equal(noCtx.code, 2);
  assert.equal(JSON.parse(noCtx.stdout).error.code, 'CONTEXT_REQUIRED');
  const bitrefill = await runCli(['request', 'https://www.bitrefill.com/invoice/abc', '--context', 'x', '--json'], { box });
  assert.equal(JSON.parse(bitrefill.stdout).error.code, 'INVOICE_UNSUPPORTED');
  const wrongHost = await runCli(['request', 'https://evil.example/payment-links/pl_01abc', '--context', 'x', '--json'], { box });
  assert.equal(JSON.parse(wrongHost.stdout).error.code, 'INVOICE_UNSUPPORTED');
  const badFunding = await runCli(['request', LINK, '--context', 'x', '--funding', 'card', '--json'], { box });
  assert.equal(JSON.parse(badFunding.stdout).error.code, 'BAD_FUNDING');
  const badKey = await runCli(['request', LINK, '--context', 'x', '--idempotency-key', 'short', '--json'], { box });
  assert.equal(JSON.parse(badKey.stdout).error.code, 'BAD_IDEMPOTENCY_KEY');
  assert.equal(mock.calls.length, 0);
});

test('router error codes map to coded failures with plain messages', async () => {
  const box = sandbox();
  writeCred(box);
  const cases = [
    ['POST /v1/agent-checkout/requests', err(401, 'UNAUTHORIZED'), ['request', LINK, '--context', 'x', '--json'], 'UNAUTHORIZED', /not confirmed the binding in Discord/],
    ['POST /v1/agent-checkout/requests', err(409, 'IDEMPOTENCY_CONFLICT'), ['request', LINK, '--context', 'x', '--json'], 'IDEMPOTENCY_CONFLICT', /different request/],
    ['POST /v1/agent-checkout/requests', err(503, 'AC_DISABLED'), ['request', LINK, '--context', 'x', '--json'], 'AC_DISABLED', /switched off/],
    ['POST /v1/agent-checkout/requests', err(409, 'INVOICE_IN_PROGRESS', { spendRequestId: 'sr_existing00000001', displayRef: 'AC-1' }), ['request', LINK, '--context', 'x', '--json'], 'INVOICE_IN_PROGRESS', /already in progress/],
    ['GET /v1/agent-checkout/requests/sr_missing000000001', err(404, 'NOT_FOUND'), ['request-status', 'sr_missing000000001', '--json'], 'NOT_FOUND', /no such spend request/],
    ['GET /v1/agent-checkout/binding', err(401, 'UNAUTHORIZED'), ['binding-status', '--json'], 'UNAUTHORIZED', /Discord/],
    ['GET /v1/agent-checkout/binding', err(503, 'AC_DISABLED'), ['binding-status', '--json'], 'AC_DISABLED', /Nothing was requested/],
  ];
  for (const [route, response, args, code, message] of cases) {
    resetMock();
    mock.routes[route] = response;
    const r = await runCli(args, { box });
    assert.equal(r.code, 1, `${code}: ${r.stdout}`);
    const p = JSON.parse(r.stdout);
    assert.equal(p.success, false);
    assert.equal(p.error.code, code);
    assert.match(p.error.message, message);
    assert.equal(p.error.details.httpStatus, response.status);
    assert.equal(r.stdout.includes(CREDENTIAL), false);
    if (code === 'INVOICE_IN_PROGRESS') assert.equal(p.error.details.spendRequestId, 'sr_existing00000001');
    if (args[0] === 'request') assert.match(p.error.details.idempotencyKey, /^cli_/);
  }
});

test('request-status prints the agent view', async () => {
  resetMock();
  mock.routes['GET /v1/agent-checkout/requests/sr_0123456789abcdef'] = { status: 200, body: { request: requestView({ status: 'succeeded' }) } };
  const box = sandbox();
  writeCred(box);
  const r = await runCli(['request-status', 'sr_0123456789abcdef'], { box });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /succeeded/);
  assert.match(r.stdout, /AC-7K2Q/);
  assert.match(r.stdout, /10\.15 USDC/);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('redact masks agent checkout credentials and bind codes anywhere in text', async () => {
  const { redact } = await import('../scripts/src/lib/output.mjs');
  const s = redact(`cred ${CREDENTIAL} code ${BIND_CODE}`);
  assert.equal(s.includes(CREDENTIAL), false);
  assert.equal(s.includes(BIND_CODE), false);
  assert.match(s, /ac_live_<redacted>/);
  assert.match(s, /acbind_live_<redacted>/);
  // The masked display form survives.
  assert.equal(redact(`ac_live_…${CREDENTIAL.slice(-4)}`), `ac_live_…${CREDENTIAL.slice(-4)}`);
});

test('maskCredential and formatUsdcAtomic', async () => {
  const { maskCredential, formatUsdcAtomic, parseInvoice } = await import('../scripts/src/lib/agent-checkout.mjs');
  assert.equal(maskCredential(CREDENTIAL), `ac_live_…${CREDENTIAL.slice(-4)}`);
  assert.equal(maskCredential('garbage'), '<redacted>');
  assert.equal(formatUsdcAtomic('1'), '0.000001');
  assert.equal(formatUsdcAtomic('10000000'), '10.00');
  assert.equal(formatUsdcAtomic('x'), null);
  assert.deepEqual(parseInvoice('https://payments.coinbase.com/payment-sessions/paymentSession_abc-DEF_1'), {
    url: 'https://payments.coinbase.com/payment-sessions/paymentSession_abc-DEF_1',
    invoiceId: 'paymentSession_abc-DEF_1',
  });
});
