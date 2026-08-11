/**
 * Redaction, broadcast-outcome classification, tracked-secret detection, and
 * the identifier charsets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { redact, redactDeep, EXIT_OK, EXIT_ERROR, EXIT_UNCONFIRMED } from '../scripts/src/lib/output.mjs';
import { broadcastOutcome } from '../scripts/src/lib/outcomes.mjs';
import { assertNoTrackedDotEnv } from '../scripts/src/lib/keys.mjs';
import { extractLinkId, maskAddress } from '../scripts/src/lib/ids.mjs';

test('redact removes key material', () => {
  const key = `0x${'ab'.repeat(32)}`;
  assert.ok(!redact(`signing failed with ${key}`).includes(key));
  assert.ok(!redact(`raw ${'cd'.repeat(32)} here`).includes('cd'.repeat(32)));
  const b58 = 'z'.repeat(88);
  assert.ok(!redact(`secret ${b58}`).includes(b58));
  const arr = `[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`;
  assert.ok(!redact(`key ${arr}`).includes('63'));
});

test('redact strips credentials out of provider URLs', () => {
  const cases = [
    'https://eth-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123',
    'https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef',
    'https://user:hunter2@rpc.example.com/path',
    'https://rpc.example.com/?apiKey=SUPERSECRETKEY123',
  ];
  for (const url of cases) {
    const out = redact(`HTTP request failed: ${url}`);
    assert.ok(!out.includes('SUPERSECRETKEY123'), `${url} -> ${out}`);
    assert.ok(!out.includes('hunter2'), `${url} -> ${out}`);
    assert.ok(!out.includes('0123456789abcdef'), `${url} -> ${out}`);
    // The host survives, so the operator can still tell which provider broke.
    assert.match(out, /example\.com|alchemy\.com|infura\.io/);
  }
});

test('redact strips bearer tokens and key-value secrets', () => {
  assert.ok(!redact('Authorization: Bearer abcdef1234567890XYZ').includes('abcdef1234567890XYZ'));
  assert.ok(!redact('api_key=abcdef123456').includes('abcdef123456'));
  assert.ok(!redact('token: "sk-livesecret12345"').includes('sk-livesecret12345'));
});

test('redactDeep scrubs secret-looking object keys and nested strings', () => {
  const out = redactDeep({
    privateKey: `0x${'11'.repeat(32)}`,
    nested: { mnemonic: 'word '.repeat(12).trim(), url: 'https://rpc.example.com/v2/SECRETKEY1' },
    list: ['https://rpc.example.com/v2/SECRETKEY2'],
    safe: 'ok',
  });
  assert.equal(out.privateKey, '<redacted>');
  assert.equal(out.nested.mnemonic, '<redacted>');
  assert.ok(!JSON.stringify(out).includes('SECRETKEY1'));
  assert.ok(!JSON.stringify(out).includes('SECRETKEY2'));
  assert.equal(out.safe, 'ok');
});

test('broadcastOutcome distinguishes reverted from unheard-of', () => {
  const ok = broadcastOutcome({ receiptStatus: 'success' });
  assert.deepEqual(
    [ok.success, ok.exitCode, ok.recordStatus],
    [true, EXIT_OK, 'confirmed'],
  );

  // A reverted EVM transfer is a FAILURE and must exit non-zero.
  const reverted = broadcastOutcome({ receiptStatus: 'reverted' });
  assert.equal(reverted.success, false);
  assert.equal(reverted.exitCode, EXIT_ERROR);
  assert.equal(reverted.code, 'TX_REVERTED');
  assert.equal(reverted.recordStatus, 'failed');

  // A Solana execution error is a failure, not a timeout.
  const failed = broadcastOutcome({ executionError: { InstructionError: [0, 'Custom'] } });
  assert.equal(failed.success, false);
  assert.equal(failed.exitCode, EXIT_ERROR);
  assert.equal(failed.code, 'TX_FAILED');
  assert.equal(failed.recordStatus, 'failed');

  // No receipt at all: unresolved, exit 3, recorded as submitted.
  const unheard = broadcastOutcome({ receiptStatus: null });
  assert.equal(unheard.exitCode, EXIT_UNCONFIRMED);
  assert.equal(unheard.recordStatus, 'submitted');
  assert.notEqual(unheard.exitCode, EXIT_ERROR);
});

function gitRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('tracked .env and .env.* variants are both caught', () => {
  for (const name of ['.env', '.env.local', '.env.production', '.env.e2e-20260101']) {
    gitRepo((dir) => {
      fs.writeFileSync(path.join(dir, name), 'KEY=value\n');
      execFileSync('git', ['add', '-f', name], { cwd: dir });
      assert.throws(
        () => assertNoTrackedDotEnv(dir),
        (e) => e.code === 'TRACKED_DOTENV',
        `${name} must be caught`,
      );
    });
  }
});

test('an untracked .env is fine, and .env.example is always fine', () => {
  gitRepo((dir) => {
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
    assert.doesNotThrow(() => assertNoTrackedDotEnv(dir));
  });
  gitRepo((dir) => {
    fs.writeFileSync(path.join(dir, '.env.example'), 'KEY=\n');
    execFileSync('git', ['add', '-f', '.env.example'], { cwd: dir });
    assert.doesNotThrow(() => assertNoTrackedDotEnv(dir));
  });
});

test('a directory with no env files, and a non-repo, are both fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-noenv-'));
  try {
    assert.doesNotThrow(() => assertNoTrackedDotEnv(dir));
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
    // Not a git repository at all — nothing to leak into.
    assert.doesNotThrow(() => assertNoTrackedDotEnv(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no git binary is needed: outside any repo the check passes definitively', () => {
  // The old implementation shelled out to git and had to refuse when the
  // binary was missing. The index-reading implementation answers without a
  // subprocess: no .git anywhere up the tree means there is no repository to
  // leak into — a definite pass, not an unverifiable state.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-nogit-'));
  const prevPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
    process.env.PATH = '';
    const res = assertNoTrackedDotEnv(dir);
    assert.equal(res.tracked, false);
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an uninterpretable git index fails CLOSED', () => {
  // Unsupported index versions (v4 path compression) and corrupt indexes must
  // refuse: "could not check" is exactly when a tracked key would slip through.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-badindex-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
    // A structurally plausible v4 index with a correct SHA-1 trailer: the
    // version check must reject it even when the checksum passes.
    const head = Buffer.alloc(12);
    head.write('DIRC', 0, 'latin1');
    head.writeUInt32BE(4, 4); // version 4: unsupported by the parser
    head.writeUInt32BE(0, 8);
    const v4 = Buffer.concat([head, crypto.createHash('sha1').update(head).digest()]);
    fs.writeFileSync(path.join(dir, '.git', 'index'), v4);
    assert.throws(
      () => assertNoTrackedDotEnv(dir),
      (e) => e.code === 'TRACKED_DOTENV_UNVERIFIABLE',
    );
    fs.writeFileSync(path.join(dir, '.git', 'index'), Buffer.from('garbage'));
    assert.throws(
      () => assertNoTrackedDotEnv(dir),
      (e) => e.code === 'TRACKED_DOTENV_UNVERIFIABLE',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a repo with no index yet means nothing is tracked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-freshrepo-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
    const res = assertNoTrackedDotEnv(dir);
    assert.equal(res.tracked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tracked-secret check fails CLOSED when the directory cannot be listed', () => {
  const missing = path.join(os.tmpdir(), `rozo-gone-${Date.now()}`);
  assert.throws(
    () => assertNoTrackedDotEnv(missing),
    (e) => e.code === 'TRACKED_DOTENV_UNVERIFIABLE',
    'an unlistable directory must refuse, not pass',
  );
});

test('the tracked-secret check fails CLOSED when git cannot read the index', () => {
  // A real repository whose index is corrupt: git can tell us it IS a repo but
  // cannot tell us what is tracked in it. That question stays open, so the
  // answer must be a refusal rather than an assumption of safety.
  gitRepo((dir) => {
    fs.writeFileSync(path.join(dir, '.env'), 'KEY=value\n');
    execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'garbage');
    assert.throws(
      () => assertNoTrackedDotEnv(dir),
      (e) => e.code === 'TRACKED_DOTENV_UNVERIFIABLE',
      'an unreadable index must refuse, not pass',
    );
  });
});

test('payment-session ids may contain _ and -', () => {
  const id = 'paymentSession_01ab-CD_ef';
  assert.deepEqual(extractLinkId(`https://payments.coinbase.com/payment-sessions/${id}`), {
    linkId: id,
    kind: 'payment_session',
  });
  assert.equal(extractLinkId('pl_01ABCdef123').kind, 'payment_link');
  assert.throws(
    () => extractLinkId('https://commerce.coinbase.com/pay/abc-123'),
    (e) => e.code === 'LEGACY_COMMERCE_URL',
  );
  assert.throws(() => extractLinkId('nonsense'), (e) => e.code === 'BAD_LINK');
});

test('address masking keeps first 6 and last 4 only', () => {
  assert.equal(maskAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234...5678');
  assert.equal(maskAddress(''), '(none)');
  assert.equal(maskAddress('short'), 'short');
});
