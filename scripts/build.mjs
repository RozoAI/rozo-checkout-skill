#!/usr/bin/env node
/**
 * Build: bundle each entry point in scripts/src into a single self-contained
 * file in scripts/dist, so the skill can be run with plain `node` and no
 * install step at the call site.
 *
 * The vendored compromised-address list is copied next to the bundles; the
 * loader looks for it there first and fails closed if it is absent.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const distDir = path.join(here, 'dist');

// Standalone scripts are built from their thin bin/ wrappers; the flows they
// import are shared with the CLI, so no guard logic is duplicated.
const SCRIPTS = ['quote', 'create-order', 'status', 'send-evm', 'send-sol'];

fs.mkdirSync(distDir, { recursive: true });

await build({
  // Explicit out names keep the documented dist/<name>.js paths, regardless of
  // where the entry file lives in src/.
  entryPoints: [
    ...SCRIPTS.map((n) => ({ in: path.join(srcDir, 'bin', `${n}.mjs`), out: n })),
    { in: path.join(srcDir, 'cli.mjs'), out: 'cli' },
  ],
  outdir: distDir,
  outExtension: { '.js': '.js' },
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  // CommonJS dependencies pulled in transitively expect the CJS module scope.
  // `require` alone is not enough: the `bindings` package (reached from the
  // Solana native-binding path) reads `__filename` at module scope, and without
  // it every bundle throws "__filename is not defined" the moment that code is
  // touched. Shim all three for every bundle, not just the CLI.
  banner: {
    js: [
      "import { createRequire as __rozoCreateRequire } from 'node:module';",
      "import { fileURLToPath as __rozoFileURLToPath } from 'node:url';",
      "import { dirname as __rozoDirname } from 'node:path';",
      'const require = __rozoCreateRequire(import.meta.url);',
      'const __filename = __rozoFileURLToPath(import.meta.url);',
      'const __dirname = __rozoDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

fs.copyFileSync(
  path.join(srcDir, 'lib', 'blacklist.json'),
  path.join(distDir, 'blacklist.json'),
);

// The published CLI is executed directly by npx.
fs.chmodSync(path.join(distDir, 'cli.js'), 0o755);

console.log(`built ${SCRIPTS.length + 1} bundles + blacklist.json into scripts/dist`);
