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

const ENTRIES = ['quote', 'create-order', 'status', 'send-evm', 'send-sol'];

fs.mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: ENTRIES.map((n) => path.join(srcDir, `${n}.mjs`)),
  outdir: distDir,
  outExtension: { '.js': '.js' },
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: [
      "import { createRequire as __rozoCreateRequire } from 'node:module';",
      'const require = __rozoCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

fs.copyFileSync(
  path.join(srcDir, 'lib', 'blacklist.json'),
  path.join(distDir, 'blacklist.json'),
);

console.log(`built ${ENTRIES.length} bundles + blacklist.json into scripts/dist`);
