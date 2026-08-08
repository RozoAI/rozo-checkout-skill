/**
 * The `.env` reader for hot-wallet settings.
 *
 * The properties that matter:
 *  - it parses as text and never evaluates anything
 *  - it reads an allow-list, so unrelated secrets in the same file stay put
 *  - the real environment always wins
 *  - errors quote a line NUMBER, never the line, which could be a secret
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseDotenv,
  filterAllowed,
  isAllowedKey,
  resolveEnvFile,
  applyDotenv,
  ALLOWED_KEYS,
} from '../scripts/src/lib/dotenv.mjs';

const KEY = '0x' + '11'.repeat(32);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-dotenv-'));
}

function writeEnv(dir, contents, mode = 0o600) {
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
  return file;
}

test('parses the shapes a real .env uses', () => {
  const vars = parseDotenv(
    [
      '# a comment',
      '',
      '   ',
      'ROZO_CHECKOUT_EVM_KEY=' + KEY,
      'export ROZO_CHECKOUT_SOL_KEY=abc123',
      'QUOTED_DOUBLE="hello world"',
      "QUOTED_SINGLE='hello world'",
      '  SPACED  =  value  ',
      '# another comment',
      'EMPTY=',
    ].join('\n'),
  );
  assert.equal(vars.ROZO_CHECKOUT_EVM_KEY, KEY);
  assert.equal(vars.ROZO_CHECKOUT_SOL_KEY, 'abc123', 'the export prefix is stripped');
  assert.equal(vars.QUOTED_DOUBLE, 'hello world');
  assert.equal(vars.QUOTED_SINGLE, 'hello world');
  assert.equal(vars.SPACED, 'value');
  assert.equal(vars.EMPTY, '');
});

test('CRLF files parse the same as LF', () => {
  const vars = parseDotenv('ROZO_CHECKOUT_EVM_KEY=' + KEY + '\r\nOTHER=x\r\n');
  assert.equal(vars.ROZO_CHECKOUT_EVM_KEY, KEY);
  assert.equal(vars.OTHER, 'x');
});

test('a value containing = is kept whole', () => {
  const vars = parseDotenv('ROZO_CHECKOUT_KEYSTORE_PASSPHRASE=a=b=c\nURL=https://x/?a=1&b=2');
  assert.equal(vars.ROZO_CHECKOUT_KEYSTORE_PASSPHRASE, 'a=b=c');
  assert.equal(vars.URL, 'https://x/?a=1&b=2');
});

test('values are literal text: nothing is expanded or executed', () => {
  const vars = parseDotenv(
    [
      'A=$(whoami)',
      'B=`id`',
      'C=$HOME/x',
      'D=one two three',
      'E=semi;colon && echo hi',
      'F=${OTHER}',
    ].join('\n'),
  );
  // Every one of these must survive verbatim — no substitution, no splitting.
  assert.equal(vars.A, '$(whoami)');
  assert.equal(vars.B, '`id`');
  assert.equal(vars.C, '$HOME/x');
  assert.equal(vars.D, 'one two three');
  assert.equal(vars.E, 'semi;colon && echo hi');
  assert.equal(vars.F, '${OTHER}');
});

test('a malformed line reports its number and never its content', () => {
  const secret = 'this-line-contains-a-secret-value';
  const err = (() => {
    try {
      parseDotenv(`GOOD=1\n${secret}\nALSO_GOOD=2`);
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err.code, 'BAD_ENV_FILE');
  assert.match(err.message, /line 2/);
  assert.ok(!err.message.includes(secret), 'the offending line must not be echoed');

  const err2 = (() => {
    try {
      parseDotenv('1BAD_KEY=x');
    } catch (e) {
      return e;
    }
  })();
  assert.equal(err2.code, 'BAD_ENV_FILE');
  assert.match(err2.message, /line 1/);
  assert.ok(!err2.message.includes('1BAD_KEY'));
});

test('only our own keys are allowed through', () => {
  for (const k of ALLOWED_KEYS) assert.ok(isAllowedKey(k), k);
  assert.ok(isAllowedKey('ROZO_CHECKOUT_RPC_8453'));
  assert.ok(isAllowedKey('ROZO_CHECKOUT_RPC_900'));
  for (const k of ['PATH', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'SECRET', 'ROZO_OTHER']) {
    assert.ok(!isAllowedKey(k), k);
  }

  const filtered = filterAllowed({
    ROZO_CHECKOUT_EVM_KEY: KEY,
    ROZO_CHECKOUT_RPC_8453: 'https://rpc',
    SECRET: 'do-not-read-me',
    AWS_SECRET_ACCESS_KEY: 'nope',
  });
  assert.deepEqual(Object.keys(filtered).sort(), ['ROZO_CHECKOUT_EVM_KEY', 'ROZO_CHECKOUT_RPC_8453']);
});

test('a stray secret in the same file is never loaded', () => {
  const dir = tempDir();
  try {
    writeEnv(dir, `ROZO_CHECKOUT_EVM_KEY=${KEY}\nAWS_SECRET_ACCESS_KEY=leak-me\nSECRET=leak-me-too\n`);
    const env = {};
    const res = applyDotenv({ cwd: dir, env });
    assert.deepEqual(res.applied, ['ROZO_CHECKOUT_EVM_KEY']);
    assert.equal(res.ignored, 2);
    assert.equal(env.ROZO_CHECKOUT_EVM_KEY, KEY);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.SECRET, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real environment wins over the file', () => {
  const dir = tempDir();
  try {
    writeEnv(dir, `ROZO_CHECKOUT_EVM_KEY=from-file\nROZO_CHECKOUT_SOL_KEY=also-from-file\n`);
    const env = { ROZO_CHECKOUT_EVM_KEY: 'from-process' };
    const res = applyDotenv({ cwd: dir, env });
    assert.equal(env.ROZO_CHECKOUT_EVM_KEY, 'from-process', 'inline env must not be overridden');
    assert.equal(env.ROZO_CHECKOUT_SOL_KEY, 'also-from-file', 'unset keys still come from the file');
    assert.deepEqual(res.applied, ['ROZO_CHECKOUT_SOL_KEY']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty process value counts as unset', () => {
  const dir = tempDir();
  try {
    writeEnv(dir, `ROZO_CHECKOUT_EVM_KEY=${KEY}\n`);
    const env = { ROZO_CHECKOUT_EVM_KEY: '   ' };
    applyDotenv({ cwd: dir, env });
    assert.equal(env.ROZO_CHECKOUT_EVM_KEY, KEY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no .env means nothing happens', () => {
  const dir = tempDir();
  try {
    const env = {};
    assert.equal(applyDotenv({ cwd: dir, env }), null);
    assert.deepEqual(env, {});
    assert.equal(resolveEnvFile({ cwd: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit --env-file is used, and a missing one is an error', () => {
  const dir = tempDir();
  try {
    const custom = path.join(dir, 'custom.env');
    fs.writeFileSync(custom, `ROZO_CHECKOUT_SOL_KEY=${KEY}\n`, { mode: 0o600 });
    fs.chmodSync(custom, 0o600);
    const env = {};
    const res = applyDotenv({ file: custom, env });
    assert.equal(res.path, custom);
    assert.equal(env.ROZO_CHECKOUT_SOL_KEY, KEY);

    assert.throws(
      () => applyDotenv({ file: path.join(dir, 'nope.env'), env: {} }),
      (e) => e.code === 'ENV_FILE_MISSING',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a group- or world-readable .env is refused with a fix', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  try {
    for (const mode of [0o644, 0o640, 0o604, 0o666]) {
      writeEnv(dir, `ROZO_CHECKOUT_EVM_KEY=${KEY}\n`, mode);
      const err = (() => {
        try {
          applyDotenv({ cwd: dir, env: {} });
        } catch (e) {
          return e;
        }
      })();
      assert.equal(err?.code, 'ENV_FILE_PERMISSIONS', `mode ${mode.toString(8)}`);
      assert.match(err.message, /chmod 600/);
      assert.ok(!err.message.includes(KEY), 'no value may appear in the error');
    }
    // 600 is accepted.
    writeEnv(dir, `ROZO_CHECKOUT_EVM_KEY=${KEY}\n`, 0o600);
    assert.ok(applyDotenv({ cwd: dir, env: {} }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a parse failure in a real file still hides the content', () => {
  const dir = tempDir();
  try {
    writeEnv(dir, `ROZO_CHECKOUT_EVM_KEY=${KEY}\nthis is not valid\n`);
    const err = (() => {
      try {
        applyDotenv({ cwd: dir, env: {} });
      } catch (e) {
        return e;
      }
    })();
    assert.equal(err.code, 'BAD_ENV_FILE');
    assert.match(err.message, /line 2/);
    assert.ok(!err.message.includes('this is not valid'));
    assert.ok(!err.message.includes(KEY));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
