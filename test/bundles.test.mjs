/**
 * Smoke tests that EXECUTE every built bundle.
 *
 * These exist because of a real shipped bug: the esbuild banner shimmed
 * `require` for bundled CommonJS dependencies but not `__filename`, so the
 * `bindings` package (reached from the Solana native-binding path) threw
 * "__filename is not defined" as soon as that code was touched. It escaped
 * review because the only thing ever run against a built bundle was `--help`,
 * which never reaches it.
 *
 * So: run each bundle for real, and assert the process neither crashes nor
 * mentions a missing global. No network — every invocation here fails fast on
 * arguments or local state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'scripts', 'dist');

const BUNDLES = ['cli.js', 'quote.js', 'create-order.js', 'status.js', 'send-evm.js', 'send-sol.js'];

/** Globals a CommonJS dependency may expect from the module scope. */
const CJS_GLOBALS = ['__filename', '__dirname', 'require', 'module', 'exports'];

function run(bundle, args = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-bundle-home-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rozo-bundle-state-'));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(DIST, bundle), ...args],
      {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          ROZO_CHECKOUT_STATE_DIR: stateDir,
        },
      },
      (err, stdout, stderr) => {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
        resolve({
          exitCode: err ? (err.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

test('every bundle exists and carries the CommonJS shims', () => {
  for (const b of BUNDLES) {
    const file = path.join(DIST, b);
    assert.ok(fs.existsSync(file), `${b} must be built`);
    const head = fs.readFileSync(file, 'utf8').slice(0, 600);
    assert.match(head, /const require = /, `${b} must shim require`);
    assert.match(head, /const __filename = /, `${b} must shim __filename`);
    assert.match(head, /const __dirname = /, `${b} must shim __dirname`);
  }
});

test('no bundle references a CommonJS global it has not defined', () => {
  for (const b of BUNDLES) {
    const src = fs.readFileSync(path.join(DIST, b), 'utf8');
    for (const g of ['__filename', '__dirname']) {
      if (!src.includes(g)) continue;
      // If the bundle mentions it at all, it must also define it.
      assert.match(
        src.slice(0, 600),
        new RegExp(`const ${g} = `),
        `${b} uses ${g} but does not define it`,
      );
    }
  }
});

for (const bundle of BUNDLES) {
  test(`${bundle} runs without a missing-global crash`, async () => {
    // No arguments: each bundle should reach its own argument handling and
    // exit cleanly. The point is that it gets that far at all.
    const res = await run(bundle);

    assert.ok(
      !/is not defined/.test(res.stderr),
      `${bundle} stderr mentions a missing global:\n${res.stderr}`,
    );
    for (const g of CJS_GLOBALS) {
      assert.ok(
        !new RegExp(`${g} is not defined`).test(res.stderr + res.stdout),
        `${bundle} reported ${g} is not defined`,
      );
    }
    assert.ok(!/ReferenceError/.test(res.stderr), `${bundle} threw a ReferenceError:\n${res.stderr}`);

    // 0 = did something, 1 = refused, 2 = usage. Anything else (crash) fails.
    assert.ok(
      [0, 1, 2].includes(res.exitCode),
      `${bundle} exited ${res.exitCode}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );

    // And it must have produced its documented single JSON object, or help.
    const printed = res.stdout.trim();
    assert.ok(printed.length > 0, `${bundle} printed nothing`);
  });
}

test('cli.js --help and --version run clean', async () => {
  for (const args of [['--help'], ['--version']]) {
    const res = await run('cli.js', args);
    assert.equal(res.exitCode, 0, `cli.js ${args.join(' ')} exited ${res.exitCode}`);
    assert.ok(!/is not defined/.test(res.stderr), res.stderr);
    assert.ok(res.stdout.trim().length > 0);
  }
});

test('the send bundles reach their own logic rather than crashing on load', async () => {
  // A syntactically valid but unknown order: proves the whole module graph —
  // including the Solana native-binding path that broke — loaded and ran.
  for (const bundle of ['send-evm.js', 'send-sol.js']) {
    const res = await run(bundle, [
      '--rozo-payment-id',
      '11111111-2222-4333-8444-555555555555',
      '--send',
    ]);
    assert.ok(!/is not defined/.test(res.stderr), `${bundle}: ${res.stderr}`);
    let json = null;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      assert.fail(`${bundle} did not print one JSON object:\n${res.stdout}`);
    }
    assert.equal(json.success, false);
    // It got as far as our own checks, which is the point.
    assert.ok(
      ['NO_KEY_SOURCE', 'NO_ORDER_STATE', 'MISSING_KEY', 'BAD_KEY_FORMAT'].includes(
        json.error?.code,
      ),
      `${bundle} unexpected code ${json.error?.code}`,
    );
  }
});
