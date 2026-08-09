/**
 * The Mode B preflight: can this machine sign, asked before anything exists.
 *
 * Reported by a first-time user (2026-08-09): with no Solana key configured,
 * confirming the payment printed "Sending…" and only then failed. In a payment
 * tool that is worse than a bad label — the user cannot tell whether money
 * moved. planSignability answers the question up front, while the answer is
 * still free and no order is expiring behind the failure.
 *
 * The tests that matter most here are the NEGATIVE ones: a preflight that is
 * too eager to say "no key" would reject wallets that can pay perfectly well,
 * which is a worse bug than the one being fixed.
 *
 * HOME is redirected to a temp directory throughout, so these tests can never
 * discover a developer's actual ~/.config/solana/id.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planSignability, SOL_KEY_ENV, EVM_KEY_ENV } from '../scripts/src/lib/key-source.mjs';
import { applyDotenv } from '../scripts/src/lib/dotenv.mjs';

/** A syntactically valid 64-byte solana keypair array. */
const SOL_KEYPAIR_JSON = JSON.stringify(Array.from({ length: 64 }, (_, i) => i % 256));
/** A base58 secret of the right length for ROZO_CHECKOUT_SOL_KEY. */
const SOL_ENV_KEY = '3'.repeat(88);
const EVM_ENV_KEY = `0x${'a'.repeat(64)}`;

/** Run body with HOME pointed at an empty temp dir, so no real key is visible. */
function withEmptyHome(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-sign-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return body(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** A temp cwd with an optional .env, written 0600 so hygiene checks pass. */
function withTempCwd(envContents, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-sign-cwd-'));
  try {
    if (envContents !== null) {
      const p = path.join(dir, '.env');
      fs.writeFileSync(p, envContents, { mode: 0o600 });
      fs.chmodSync(p, 0o600);
    }
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The reported bug
// ---------------------------------------------------------------------------

test('no key anywhere is refused up front, not after "Sending…"', () => {
  withEmptyHome(() => {
    withTempCwd(null, (cwd) => {
      assert.throws(
        () => planSignability({ family: 'solana', env: {}, cwd, applyEnvFile: applyDotenv }),
        (err) => {
          assert.equal(err.code, 'NO_KEY_SOURCE');
          // The message has to say what to actually do about it.
          assert.match(err.message, /solana-keygen|--keyfile|ROZO_CHECKOUT_SOL_KEY/);
          return true;
        },
      );
    });
  });
});

test('the same holds for EVM', () => {
  withEmptyHome(() => {
    withTempCwd(null, (cwd) => {
      assert.throws(
        () => planSignability({ family: 'evm', env: {}, cwd, applyEnvFile: applyDotenv }),
        (err) => {
          assert.equal(err.code, 'NO_KEY_SOURCE');
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Not over-rejecting — the regression this fix could easily introduce
// ---------------------------------------------------------------------------

test('a key that lives only in .env is found, not reported as missing', () => {
  // The send script applies --env-file to process.env itself, so a preflight
  // reading a bare process.env would call this wallet unpayable. That would
  // turn a UX fix into a hard blocker for anyone using the documented
  // .env-based setup.
  withEmptyHome(() => {
    withTempCwd(`${SOL_KEY_ENV}=${SOL_ENV_KEY}\n`, (cwd) => {
      const plan = planSignability({
        family: 'solana',
        env: {},
        cwd,
        applyEnvFile: applyDotenv,
      });
      assert.equal(plan.kind, 'env');
      assert.equal(plan.label, SOL_KEY_ENV);
    });
  });
});

test('an explicit --env-file is honoured the same way', () => {
  withEmptyHome(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-sign-envfile-'));
    try {
      const file = path.join(dir, 'custom.env');
      fs.writeFileSync(file, `${EVM_KEY_ENV}=${EVM_ENV_KEY}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      const plan = planSignability({
        family: 'evm',
        envFile: file,
        env: {},
        cwd: dir,
        applyEnvFile: applyDotenv,
      });
      assert.equal(plan.kind, 'env');
      assert.equal(plan.label, EVM_KEY_ENV);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the standard solana-keygen keypair is found', () => {
  withEmptyHome((home) => {
    const dir = path.join(home, '.config', 'solana');
    fs.mkdirSync(dir, { recursive: true });
    const keypair = path.join(dir, 'id.json');
    fs.writeFileSync(keypair, SOL_KEYPAIR_JSON, { mode: 0o600 });
    withTempCwd(null, (cwd) => {
      const plan = planSignability({
        family: 'solana',
        env: {},
        cwd,
        applyEnvFile: applyDotenv,
      });
      assert.equal(plan.kind, 'keypair-file');
      assert.equal(plan.path, keypair);
    });
  });
});

test('a key already in the real environment needs no .env at all', () => {
  withEmptyHome(() => {
    withTempCwd(null, (cwd) => {
      const plan = planSignability({
        family: 'solana',
        env: { [SOL_KEY_ENV]: SOL_ENV_KEY },
        cwd,
        applyEnvFile: applyDotenv,
      });
      assert.equal(plan.kind, 'env');
    });
  });
});

// ---------------------------------------------------------------------------
// No side effects — the preflight must not disturb the real send path
// ---------------------------------------------------------------------------

test('the probe never mutates the environment it was handed', () => {
  withEmptyHome(() => {
    withTempCwd(`${SOL_KEY_ENV}=${SOL_ENV_KEY}\n`, (cwd) => {
      const env = {};
      planSignability({ family: 'solana', env, cwd, applyEnvFile: applyDotenv });
      // The send script applies the dotenv itself, once, at send time. If the
      // preflight had already written these into the caller's env, that call
      // would report a different set of applied keys than it actually used.
      assert.deepEqual(env, {}, 'planSignability leaked dotenv values into the caller env');
    });
  });
});

test('the probe never returns key material, only where it would come from', () => {
  withEmptyHome(() => {
    withTempCwd(null, (cwd) => {
      const plan = planSignability({
        family: 'solana',
        env: { [SOL_KEY_ENV]: SOL_ENV_KEY },
        cwd,
        applyEnvFile: applyDotenv,
      });
      const serialized = JSON.stringify(plan);
      assert.doesNotMatch(serialized, new RegExp(SOL_ENV_KEY), 'plan carried the secret');
      assert.equal(plan.secretKey, undefined);
      assert.equal(plan.privateKey, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// Env-file hygiene still applies, just earlier
// ---------------------------------------------------------------------------

test('a world-readable .env fails the preflight instead of failing mid-send', () => {
  if (process.platform === 'win32') return;
  withEmptyHome(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-sign-perm-'));
    try {
      const file = path.join(dir, '.env');
      fs.writeFileSync(file, `${SOL_KEY_ENV}=${SOL_ENV_KEY}\n`);
      fs.chmodSync(file, 0o644);
      assert.throws(
        () =>
          planSignability({ family: 'solana', env: {}, cwd: dir, applyEnvFile: applyDotenv }),
        (err) => {
          assert.equal(err.code, 'ENV_FILE_PERMISSIONS');
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('an unreadable --env-file is reported before any order is created', () => {
  withEmptyHome(() => {
    withTempCwd(null, (cwd) => {
      assert.throws(
        () =>
          planSignability({
            family: 'solana',
            envFile: path.join(cwd, 'does-not-exist.env'),
            env: {},
            cwd,
            applyEnvFile: applyDotenv,
          }),
        (err) => {
          assert.equal(err.code, 'ENV_FILE_MISSING');
          return true;
        },
      );
    });
  });
});
