/**
 * Client result report: allowlisted payload, off by default, opt-out, and a
 * report that can never change a pay command's output or exit code. Nothing
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

import {
  buildReport,
  classifyAttempt,
  reportingEnabled,
  sendReport,
  REPORT_KEYS,
  REPORT_CLIENT,
} from '../scripts/src/lib/client-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'src', 'cli.mjs');
const UUID = '0b9a6c3e-1d2f-4a5b-8c7d-112233445566';

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

test('payload is allowlisted: extra fields such as addresses or amounts never appear', () => {
  const r = buildReport({
    outcome: 'failed',
    code: 'TX_REVERTED',
    flow: 'coinbase',
    rozoPaymentId: UUID,
    version: '9.9.9',
    address: '0x1111111111111111111111111111111111111111',
    amount: '12.34',
    txHash: '0x' + 'a'.repeat(64),
    email: 'x@example.com',
  });
  assert.deepEqual(Object.keys(r).sort(), [...REPORT_KEYS].sort());
  assert.deepEqual(r, { client: REPORT_CLIENT, version: '9.9.9', outcome: 'failed', code: 'TX_REVERTED', flow: 'coinbase', rozoPaymentId: UUID });
  for (const k of ['address', 'amount', 'txHash', 'email', 'to', 'from', 'link', 'url', 'message']) assert.equal(k in r, false);
});

test('payload rules: code null on success, bad code becomes UNKNOWN, bad id or flow dropped, bad outcome rejected', () => {
  assert.equal(buildReport({ outcome: 'succeeded', code: 'WHATEVER' }).code, null);
  assert.equal(buildReport({ outcome: 'refused', code: 'free text with 0xabc' }).code, 'UNKNOWN');
  const r = buildReport({ outcome: 'refused', code: 'CREATE_DRIFT', rozoPaymentId: 'pl_notauuid', flow: 'paypal' });
  assert.equal('rozoPaymentId' in r, false);
  assert.equal(r.flow, null);
  assert.equal(buildReport({ outcome: 'paid' }), null);
  assert.ok(Buffer.byteLength(JSON.stringify(buildReport({ outcome: 'failed', code: 'X'.repeat(64), rozoPaymentId: UUID }))) < 2048);
});

test('classifyAttempt maps exits and guard codes to outcomes', () => {
  assert.deepEqual(classifyAttempt({ code: 'CREATE_DRIFT' }, 1), { outcome: 'refused', code: 'CREATE_DRIFT' });
  assert.deepEqual(classifyAttempt({ code: 'ORDER_ALREADY_FUNDED' }, 1), { outcome: 'refused', code: 'ORDER_ALREADY_FUNDED' });
  assert.deepEqual(classifyAttempt({ code: 'REUSED_SOURCE_MISMATCH' }, 1), { outcome: 'refused', code: 'REUSED_SOURCE_MISMATCH' });
  assert.deepEqual(classifyAttempt({ code: 'TX_REVERTED' }, 1), { outcome: 'failed', code: 'TX_REVERTED' });
  assert.deepEqual(classifyAttempt({ code: 'TX_FAILED' }, 1), { outcome: 'failed', code: 'TX_FAILED' });
  assert.deepEqual(classifyAttempt({}, 3), { outcome: 'unconfirmed', code: null });
  assert.deepEqual(classifyAttempt({ settled: true }, 0), { outcome: 'succeeded', code: null });
  assert.deepEqual(classifyAttempt({ sendConfirmed: true }, 0), { outcome: 'succeeded', code: null });
  assert.deepEqual(classifyAttempt({ sendUnconfirmed: true }, 0), { outcome: 'unconfirmed', code: 'TX_UNCONFIRMED' });
  assert.deepEqual(classifyAttempt({ abandoned: true }, 0), { outcome: 'abandoned', code: 'USER_CANCELLED' });
  assert.deepEqual(classifyAttempt({}, 0), { outcome: 'unconfirmed', code: 'AWAITING_DEPOSIT' });
  assert.deepEqual(classifyAttempt({ flow: 'x402', paid: true }, 0), { outcome: 'succeeded', code: null });
  assert.equal(classifyAttempt({ flow: 'x402' }, 0), null);
  assert.equal(classifyAttempt({ skip: true }, 1), null);
  assert.equal(classifyAttempt({ code: 'USAGE' }, 2), null);
});

// ---------------------------------------------------------------------------
// Switch and transport
// ---------------------------------------------------------------------------

test('disabled by default; ROZO_CHECKOUT_REPORT=1 enables; ROZO_CHECKOUT_NO_REPORT=1 always wins', () => {
  assert.equal(reportingEnabled({}), false);
  assert.equal(reportingEnabled({ ROZO_CHECKOUT_REPORT: 'true' }), false);
  assert.equal(reportingEnabled({ ROZO_CHECKOUT_REPORT: '1' }), true);
  assert.equal(reportingEnabled({ ROZO_CHECKOUT_REPORT: '1', ROZO_CHECKOUT_NO_REPORT: '1' }), false);
});

test('sendReport: no fetch when disabled, swallows network errors, never waits past the timeout', async () => {
  const report = buildReport({ outcome: 'refused', code: 'CREATE_DRIFT' });
  let calls = 0;
  const counting = async () => {
    calls++;
    return { status: 204, ok: true };
  };
  assert.equal(await sendReport(report, { env: {}, fetchImpl: counting }), false);
  assert.equal(await sendReport(report, { env: { ROZO_CHECKOUT_REPORT: '1', ROZO_CHECKOUT_NO_REPORT: '1' }, fetchImpl: counting }), false);
  assert.equal(calls, 0);
  assert.equal(await sendReport(report, { env: { ROZO_CHECKOUT_REPORT: '1' }, fetchImpl: counting }), true);
  assert.equal(calls, 1);

  const throwing = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await sendReport(report, { env: { ROZO_CHECKOUT_REPORT: '1' }, fetchImpl: throwing }), false);

  const hanging = () => new Promise(() => {});
  const t0 = Date.now();
  assert.equal(await sendReport(report, { env: { ROZO_CHECKOUT_REPORT: '1' }, fetchImpl: hanging, timeoutMs: 100 }), false);
  assert.ok(Date.now() - t0 < 1000);
});

// ---------------------------------------------------------------------------
// End to end through the CLI
// ---------------------------------------------------------------------------

const mock = { calls: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    mock.calls.push({ url: req.url, body });
    if (req.url === '/report') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'LINK_NOT_PAYABLE', message: 'not payable' } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function runPay(extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-report-home-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ROZO_CHECKOUT_STATE_DIR: path.join(home, 'state'),
    ROZO_CHECKOUT_MPP_BASE: `${ORIGIN}/mpp`,
    ROZO_CHECKOUT_INTENTS_BASE: `${ORIGIN}/intents`,
    ROZO_CHECKOUT_REPORT_URL: `${ORIGIN}/report`,
    ROZO_CHECKOUT_ANON_ID: 'off',
    NO_COLOR: '1',
  };
  delete env.ROZO_CHECKOUT_REPORT;
  delete env.ROZO_CHECKOUT_NO_REPORT;
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, 'pay', 'https://payments.coinbase.com/payment-links/pl_01reporttest', '--with', 'usdc-base', '--yes', '--json'],
      { cwd: home, env },
      (e, stdout, stderr) => {
        fs.rmSync(home, { recursive: true, force: true });
        resolve({ code: e ? e.code ?? 1 : 0, stdout, stderr });
      },
    );
  });
}

const reports = () => mock.calls.filter((c) => c.url === '/report');

test('CLI: default off sends nothing; enabled sends one allowlisted report; output and exit code unchanged', async () => {
  mock.calls = [];
  const off = await runPay({});
  assert.equal(off.code, 1);
  assert.equal(reports().length, 0);

  mock.calls = [];
  const on = await runPay({ ROZO_CHECKOUT_REPORT: '1' });
  assert.equal(on.code, off.code);
  assert.equal(on.stdout, off.stdout);
  assert.equal(reports().length, 1);
  const body = JSON.parse(reports()[0].body);
  assert.deepEqual(Object.keys(body).sort(), ['client', 'code', 'flow', 'outcome', 'version']);
  assert.equal(body.outcome, 'refused');
  assert.equal(body.code, 'LINK_NOT_PAYABLE');
  assert.equal(body.flow, 'coinbase');
  assert.equal(body.client, 'rozo-checkout-cli');
  assert.equal(reports()[0].body.includes('pl_01reporttest'), false);

  mock.calls = [];
  const optOut = await runPay({ ROZO_CHECKOUT_REPORT: '1', ROZO_CHECKOUT_NO_REPORT: '1' });
  assert.equal(optOut.code, off.code);
  assert.equal(reports().length, 0);
});

test('CLI: an unreachable report endpoint does not change output or exit code', async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}/report`;
  await new Promise((r) => dead.close(r));

  mock.calls = [];
  const base = await runPay({});
  const broken = await runPay({ ROZO_CHECKOUT_REPORT: '1', ROZO_CHECKOUT_REPORT_URL: deadUrl });
  assert.equal(broken.code, base.code);
  assert.equal(broken.stdout, base.stdout);
  assert.equal(broken.stderr.includes('ECONNREFUSED'), false);
});
