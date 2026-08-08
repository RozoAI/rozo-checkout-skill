/**
 * Where the Mode B signing key comes from.
 *
 * Nothing here is committed: the keystore fixture is built in-test from a
 * throwaway key at a throwaway passphrase, so the repository never contains
 * real encrypted key material.
 *
 * HOME is redirected to a temp directory throughout, so these tests can never
 * discover or read a developer's actual ~/.config/solana/id.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  normalizeEvmPrivateKey,
  parseSolanaKeypairJson,
  decodeSolanaEnvKey,
  decryptKeystoreV3,
  looksLikeKeystore,
  assertKeyfileSafe,
  planKeySource,
  loadKeySource,
  expandHome,
  displayPath,
  EVM_KEY_ENV,
  SOL_KEY_ENV,
  EVM_KEYSTORE_ENV,
  KEYSTORE_PASSPHRASE_ENV,
} from '../scripts/src/lib/key-source.mjs';

// A throwaway key that controls nothing. Never used to sign anything real.
const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const TEST_PASSPHRASE = 'correct horse battery staple';

/** Build a real V3 keystore, so the decrypt path is exercised end to end. */
function makeKeystoreV3(privateKeyHex, passphrase, { kdf = 'pbkdf2' } = {}) {
  const secret = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const pass = Buffer.from(passphrase, 'utf8');

  let derived;
  let kdfparams;
  if (kdf === 'scrypt') {
    // Deliberately small parameters: this is a test, not a wallet.
    kdfparams = { dklen: 32, n: 1024, r: 8, p: 1, salt: salt.toString('hex') };
    derived = crypto.scryptSync(pass, salt, 32, { N: 1024, r: 8, p: 1 });
  } else {
    kdfparams = { dklen: 32, c: 1000, prf: 'hmac-sha256', salt: salt.toString('hex') };
    derived = crypto.pbkdf2Sync(pass, salt, 1000, 32, 'sha256');
  }

  const cipher = crypto.createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2);

  return {
    version: 3,
    id: crypto.randomUUID(),
    address: privateKeyToAccount(privateKeyHex).address.slice(2).toLowerCase(),
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf,
      kdfparams,
      mac,
    },
  };
}

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-keyhome-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeKeyfile(dir, name, contents, mode = 0o600) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const VALID_KEYPAIR_64 = Array.from({ length: 64 }, (_, i) => (i * 7) % 251);

// ---------------------------------------------------------------------------
// Solana keypair files
// ---------------------------------------------------------------------------

test('a solana-keygen keypair file parses to bytes', () => {
  const bytes = parseSolanaKeypairJson(JSON.stringify(VALID_KEYPAIR_64));
  assert.equal(bytes.length, 64);
  assert.equal(bytes[0], 0);
  assert.equal(bytes[1], 7);

  // A 32-byte seed is also legitimate.
  assert.equal(parseSolanaKeypairJson(JSON.stringify(VALID_KEYPAIR_64.slice(0, 32))).length, 32);
});

test('a malformed keypair file is refused, never partially accepted', () => {
  const cases = [
    ['not json at all', 'BAD_KEYPAIR_FILE'],
    ['{"secretKey":[1,2,3]}', 'BAD_KEYPAIR_FILE'],
    ['"a string"', 'BAD_KEYPAIR_FILE'],
    [JSON.stringify([]), 'BAD_KEYPAIR_FILE'],
    [JSON.stringify(VALID_KEYPAIR_64.slice(0, 63)), 'BAD_KEYPAIR_FILE'],
    [JSON.stringify([...VALID_KEYPAIR_64, 1]), 'BAD_KEYPAIR_FILE'],
    [JSON.stringify(VALID_KEYPAIR_64.map((b, i) => (i === 3 ? 999 : b))), 'BAD_KEYPAIR_FILE'],
    [JSON.stringify(VALID_KEYPAIR_64.map((b, i) => (i === 3 ? -1 : b))), 'BAD_KEYPAIR_FILE'],
    [JSON.stringify(VALID_KEYPAIR_64.map((b, i) => (i === 3 ? 'x' : b))), 'BAD_KEYPAIR_FILE'],
  ];
  for (const [text, code] of cases) {
    assert.throws(() => parseSolanaKeypairJson(text), (e) => e.code === code, text.slice(0, 40));
  }
});

test('the wrong-length error says what it found', () => {
  const err = (() => {
    try {
      parseSolanaKeypairJson(JSON.stringify([1, 2, 3]));
    } catch (e) {
      return e;
    }
  })();
  assert.match(err.message, /64 bytes/);
  assert.match(err.message, /this file has 3/);
});

test('the env key still accepts base58 and a byte array', () => {
  assert.equal(decodeSolanaEnvKey(JSON.stringify(VALID_KEYPAIR_64)).length, 64);
  // 32 zero bytes in base58 is a run of '1's.
  assert.equal(decodeSolanaEnvKey('1'.repeat(32)).length, 32);
  assert.throws(() => decodeSolanaEnvKey(''), (e) => e.code === 'MISSING_KEY');
  assert.throws(() => decodeSolanaEnvKey('!!!not base58!!!'), (e) => e.code === 'BAD_KEY_FORMAT');
});

// ---------------------------------------------------------------------------
// EVM private keys
// ---------------------------------------------------------------------------

test('a bare 64-hex key is accepted and normalised', () => {
  // This is exactly what MetaMask and Rabby put on the clipboard: 64 hex
  // characters, no prefix. Requiring the prefix made the two most common
  // wallets fail on first use.
  const bare = '11'.repeat(32);
  assert.equal(normalizeEvmPrivateKey(bare), `0x${bare}`);
  assert.equal(normalizeEvmPrivateKey(`  ${bare}  `), `0x${bare}`, 'surrounding space is trimmed');
});

test('a 0x-prefixed key is still accepted', () => {
  const bare = 'ab'.repeat(32);
  assert.equal(normalizeEvmPrivateKey(`0x${bare}`), `0x${bare}`);
  assert.equal(normalizeEvmPrivateKey(`0X${bare.toUpperCase()}`), `0x${bare}`, 'case is normalised');
});

test('both forms derive the same address', () => {
  const bare = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const withPrefix = `0x${bare}`;
  const a = privateKeyToAccount(normalizeEvmPrivateKey(bare)).address;
  const b = privateKeyToAccount(normalizeEvmPrivateKey(withPrefix)).address;
  const c = privateKeyToAccount(normalizeEvmPrivateKey(bare.toUpperCase())).address;
  assert.equal(a, b, 'prefix must not change the derived address');
  assert.equal(a, c, 'hex case must not change the derived address');
});

test('wrong-length and non-hex keys are refused, and never echoed', () => {
  const bare = '11'.repeat(32);
  const bad = [
    bare.slice(0, 63), // 63
    bare + 'a', // 65
    `0x${bare.slice(0, 63)}`,
    `0x${bare}a`,
    'z'.repeat(64), // right length, not hex
    `0x${'z'.repeat(64)}`,
    bare.slice(0, 62) + 'gg', // one non-hex pair
    '0x', // prefix only
    '', // empty
    '   ',
    null,
    undefined,
  ];
  for (const v of bad) {
    const err = (() => {
      try {
        normalizeEvmPrivateKey(v);
      } catch (e) {
        return e;
      }
    })();
    assert.ok(err, `${JSON.stringify(v)} must be refused`);
    assert.ok(
      ['BAD_KEY_FORMAT', 'MISSING_KEY'].includes(err.code),
      `${JSON.stringify(v)} -> ${err.code}`,
    );
    // The rejected value must never appear in the message.
    if (typeof v === 'string' && v.trim().length > 8) {
      assert.ok(!err.message.includes(v.trim()), 'the value must not be echoed');
      assert.ok(!err.message.includes(v.replace(/^0[xX]/, '')), 'the body must not be echoed');
    }
  }
});

test('the env key path accepts the bare form end to end', async () => {
  const bare = 'cd'.repeat(32);
  const env = { [EVM_KEY_ENV]: bare };
  const loaded = await loadKeySource(planKeySource({ family: 'evm', env }), {
    family: 'evm',
    env,
  });
  assert.equal(loaded.privateKey, `0x${bare}`);
  assert.equal(loaded.kind, 'env');
});

// ---------------------------------------------------------------------------
// EVM keystores
// ---------------------------------------------------------------------------

test('a V3 keystore decrypts to the original key, under both KDFs', () => {
  for (const kdf of ['pbkdf2', 'scrypt']) {
    const ks = makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE, { kdf });
    assert.equal(decryptKeystoreV3(ks, TEST_PASSPHRASE), TEST_PRIVATE_KEY, kdf);
    // Accepts the JSON text too, as read from disk.
    assert.equal(decryptKeystoreV3(JSON.stringify(ks), TEST_PASSPHRASE), TEST_PRIVATE_KEY, kdf);
  }
});

test('the decrypted key derives the address the keystore claims', () => {
  const ks = makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
  const recovered = decryptKeystoreV3(ks, TEST_PASSPHRASE);
  assert.equal(privateKeyToAccount(recovered).address.slice(2).toLowerCase(), ks.address);
});

test('a wrong passphrase is reported as such, not as a garbage key', () => {
  const ks = makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
  for (const wrong of ['', 'wrong', TEST_PASSPHRASE + ' ', TEST_PASSPHRASE.toUpperCase()]) {
    assert.throws(
      () => decryptKeystoreV3(ks, wrong),
      (e) => e.code === 'KEYSTORE_BAD_PASSPHRASE',
      JSON.stringify(wrong),
    );
  }
});

test('a tampered keystore fails the MAC rather than yielding a key', () => {
  const ks = makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
  const tampered = JSON.parse(JSON.stringify(ks));
  // Flip one byte of ciphertext: the MAC must catch it.
  tampered.crypto.ciphertext =
    (tampered.crypto.ciphertext[0] === 'a' ? 'b' : 'a') + tampered.crypto.ciphertext.slice(1);
  assert.throws(
    () => decryptKeystoreV3(tampered, TEST_PASSPHRASE),
    (e) => e.code === 'KEYSTORE_BAD_PASSPHRASE',
  );
});

test('unsupported or malformed keystores are refused', () => {
  const ks = makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
  const variant = (patch) => {
    const c = JSON.parse(JSON.stringify(ks));
    patch(c);
    return c;
  };
  assert.throws(() => decryptKeystoreV3('not json', 'x'), (e) => e.code === 'BAD_KEYSTORE');
  assert.throws(() => decryptKeystoreV3({}, 'x'), (e) => e.code === 'BAD_KEYSTORE');
  assert.throws(() => decryptKeystoreV3(null, 'x'), (e) => e.code === 'BAD_KEYSTORE');
  assert.throws(
    () => decryptKeystoreV3(variant((c) => (c.version = 1)), TEST_PASSPHRASE),
    (e) => e.code === 'BAD_KEYSTORE',
  );
  assert.throws(
    () => decryptKeystoreV3(variant((c) => (c.crypto.kdf = 'argon2')), TEST_PASSPHRASE),
    (e) => e.code === 'BAD_KEYSTORE',
  );
  assert.throws(
    () => decryptKeystoreV3(variant((c) => (c.crypto.kdfparams = {})), TEST_PASSPHRASE),
    (e) => e.code === 'BAD_KEYSTORE',
  );
});

test('keystores are told apart from keypair files', () => {
  assert.ok(looksLikeKeystore(JSON.stringify(makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE))));
  assert.ok(!looksLikeKeystore(JSON.stringify(VALID_KEYPAIR_64)));
  assert.ok(!looksLikeKeystore('{"not":"a keystore"}'));
  assert.ok(!looksLikeKeystore('nonsense'));
});

// ---------------------------------------------------------------------------
// File hygiene
// ---------------------------------------------------------------------------

test('a group- or world-readable key file is refused with a fix', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-perm-'));
  try {
    const ok = writeKeyfile(dir, 'ok.json', JSON.stringify(VALID_KEYPAIR_64), 0o600);
    assert.ok(assertKeyfileSafe(ok));

    for (const mode of [0o644, 0o640, 0o604, 0o666, 0o755]) {
      const bad = writeKeyfile(dir, `bad-${mode.toString(8)}.json`, '[]', mode);
      const err = (() => {
        try {
          assertKeyfileSafe(bad);
        } catch (e) {
          return e;
        }
      })();
      assert.equal(err?.code, 'KEYFILE_PERMISSIONS', `mode ${mode.toString(8)}`);
      assert.match(err.message, /chmod 600/);
    }

    // 0o400 (read-only by owner) is fine.
    assert.ok(assertKeyfileSafe(writeKeyfile(dir, 'ro.json', '[]', 0o400)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing key file is refused clearly', () => {
  assert.throws(
    () => assertKeyfileSafe(path.join(os.tmpdir(), `nope-${Date.now()}.json`)),
    (e) => e.code === 'KEYFILE_UNREADABLE',
  );
});

test('a git-tracked key file is refused', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-keygit-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    const file = writeKeyfile(dir, 'id.json', JSON.stringify(VALID_KEYPAIR_64), 0o600);

    // Untracked: fine.
    assert.ok(assertKeyfileSafe(file));

    // Tracked: refused.
    execFileSync('git', ['add', '-f', 'id.json'], { cwd: dir });
    const err = (() => {
      try {
        assertKeyfileSafe(file);
      } catch (e) {
        return e;
      }
    })();
    assert.equal(err?.code, 'TRACKED_KEYFILE');
    assert.match(err.message, /git rm --cached/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('precedence: --keyfile beats the standard path, which beats the env key', () => {
  withTempHome((home) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-prec-'));
    try {
      const explicit = writeKeyfile(dir, 'explicit.json', JSON.stringify(VALID_KEYPAIR_64));
      const standardDir = path.join(home, '.config', 'solana');
      fs.mkdirSync(standardDir, { recursive: true });
      const standard = writeKeyfile(standardDir, 'id.json', JSON.stringify(VALID_KEYPAIR_64));
      const env = { [SOL_KEY_ENV]: JSON.stringify(VALID_KEYPAIR_64) };

      // 1. explicit --keyfile wins over everything
      let plan = planKeySource({ family: 'solana', keyfile: explicit, env });
      assert.equal(plan.kind, 'keypair-file');
      assert.equal(plan.path, explicit);

      // 2. standard solana path wins over the env key
      plan = planKeySource({ family: 'solana', env });
      assert.equal(plan.kind, 'keypair-file');
      assert.equal(plan.path, standard);
      assert.match(plan.label, /^~\/\.config\/solana\/id\.json$/);

      // 3. env key only when no file exists
      fs.rmSync(standard);
      plan = planKeySource({ family: 'solana', env });
      assert.equal(plan.kind, 'env');
      assert.equal(plan.label, SOL_KEY_ENV);

      // 4. nothing at all is a clear refusal naming every option
      assert.throws(
        () => planKeySource({ family: 'solana', env: {} }),
        (e) => e.code === 'NO_KEY_SOURCE',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('precedence on EVM: --keyfile, then the keystore env, then the raw key', () => {
  withTempHome(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-prec-evm-'));
    try {
      const ks = JSON.stringify(makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE));
      const explicit = writeKeyfile(dir, 'wallet.json', ks);
      const viaEnv = writeKeyfile(dir, 'other.json', ks);
      const env = { [EVM_KEYSTORE_ENV]: viaEnv, [EVM_KEY_ENV]: TEST_PRIVATE_KEY };

      let plan = planKeySource({ family: 'evm', keyfile: explicit, env });
      assert.equal(plan.kind, 'keystore');
      assert.equal(plan.path, explicit);

      plan = planKeySource({ family: 'evm', env });
      assert.equal(plan.kind, 'keystore');
      assert.equal(plan.path, viaEnv);

      plan = planKeySource({ family: 'evm', env: { [EVM_KEY_ENV]: TEST_PRIVATE_KEY } });
      assert.equal(plan.kind, 'env');
      assert.equal(plan.label, EVM_KEY_ENV);

      assert.throws(
        () => planKeySource({ family: 'evm', env: {} }),
        (e) => e.code === 'NO_KEY_SOURCE',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a file of the wrong kind for the chain is refused, not misread', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-kind-'));
  try {
    const keypair = writeKeyfile(dir, 'id.json', JSON.stringify(VALID_KEYPAIR_64));
    const keystore = writeKeyfile(
      dir,
      'wallet.json',
      JSON.stringify(makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE)),
    );
    assert.throws(
      () => planKeySource({ family: 'evm', keyfile: keypair, env: {} }),
      (e) => e.code === 'BAD_KEYSTORE',
    );
    assert.throws(
      () => planKeySource({ family: 'solana', keyfile: keystore, env: {} }),
      (e) => e.code === 'BAD_KEYPAIR_FILE',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

test('loading works for every source, and env keys still work unchanged', async () => {
  await withTempHome(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-load-'));
    try {
      // Solana keypair file
      const kp = writeKeyfile(dir, 'id.json', JSON.stringify(VALID_KEYPAIR_64));
      let loaded = await loadKeySource(planKeySource({ family: 'solana', keyfile: kp, env: {} }), {
        family: 'solana',
      });
      assert.equal(loaded.secretKey.length, 64);
      assert.equal(loaded.kind, 'keypair-file');

      // Solana env key — the documented unattended path, unchanged.
      const solEnv = { [SOL_KEY_ENV]: JSON.stringify(VALID_KEYPAIR_64) };
      loaded = await loadKeySource(planKeySource({ family: 'solana', env: solEnv }), {
        family: 'solana',
        env: solEnv,
      });
      assert.equal(loaded.secretKey.length, 64);
      assert.equal(loaded.kind, 'env');
      assert.equal(loaded.label, SOL_KEY_ENV);

      // EVM env key — likewise unchanged.
      const evmEnv = { [EVM_KEY_ENV]: TEST_PRIVATE_KEY };
      loaded = await loadKeySource(planKeySource({ family: 'evm', env: evmEnv }), {
        family: 'evm',
        env: evmEnv,
      });
      assert.equal(loaded.privateKey, TEST_PRIVATE_KEY);
      assert.equal(loaded.kind, 'env');

      // A bad EVM env key is still rejected by format.
      await assert.rejects(
        loadKeySource(planKeySource({ family: 'evm', env: { [EVM_KEY_ENV]: 'nope' } }), {
          family: 'evm',
          env: { [EVM_KEY_ENV]: 'nope' },
        }),
        (e) => e.code === 'BAD_KEY_FORMAT',
      );

      // Keystore with the passphrase supplied for unattended use.
      const ksFile = writeKeyfile(
        dir,
        'wallet.json',
        JSON.stringify(makeKeystoreV3(TEST_PRIVATE_KEY, TEST_PASSPHRASE)),
      );
      const ksEnv = { [KEYSTORE_PASSPHRASE_ENV]: TEST_PASSPHRASE };
      loaded = await loadKeySource(planKeySource({ family: 'evm', keyfile: ksFile, env: ksEnv }), {
        family: 'evm',
        env: ksEnv,
      });
      assert.equal(loaded.privateKey, TEST_PRIVATE_KEY);
      assert.equal(loaded.kind, 'keystore');

      // Keystore with a prompt callback instead.
      let prompted = 0;
      loaded = await loadKeySource(planKeySource({ family: 'evm', keyfile: ksFile, env: {} }), {
        family: 'evm',
        env: {},
        askPassphrase: async () => {
          prompted++;
          return TEST_PASSPHRASE;
        },
      });
      assert.equal(prompted, 1, 'the passphrase must be requested exactly once');
      assert.equal(loaded.privateKey, TEST_PRIVATE_KEY);

      // No passphrase and no way to ask: refuse, do not try an empty one.
      await assert.rejects(
        loadKeySource(planKeySource({ family: 'evm', keyfile: ksFile, env: {} }), {
          family: 'evm',
          env: {},
        }),
        (e) => e.code === 'KEYSTORE_PASSPHRASE_REQUIRED',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('loading refuses a world-readable file before reading it', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-loadperm-'));
  try {
    const kp = writeKeyfile(dir, 'id.json', JSON.stringify(VALID_KEYPAIR_64), 0o644);
    await assert.rejects(
      loadKeySource({ kind: 'keypair-file', path: kp, label: 'id.json' }, { family: 'solana' }),
      (e) => e.code === 'KEYFILE_PERMISSIONS',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path display
// ---------------------------------------------------------------------------

test('paths are shown relative to home, never as absolute user paths', () => {
  withTempHome((home) => {
    assert.equal(displayPath(path.join(home, '.config', 'solana', 'id.json')), '~/.config/solana/id.json');
    assert.equal(displayPath('/etc/somewhere'), '/etc/somewhere');
    assert.equal(expandHome('~/x/y'), path.join(home, 'x', 'y'));
    assert.equal(expandHome('~'), home);
    assert.equal(expandHome('/abs/path'), '/abs/path');
  });
});
