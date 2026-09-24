import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('Claude plugin version tracks the npm package version', () => {
  const pkg = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.name, 'rozo-checkout');
});

test('marketplace lists the plugin from the repository root', () => {
  const market = read('.claude-plugin/marketplace.json');
  const entry = market.plugins.find((p) => p.name === 'rozo-checkout');
  assert.ok(entry, 'rozo-checkout entry missing');
  assert.equal(entry.source, './');
});
