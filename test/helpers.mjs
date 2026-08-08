import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Load a JSON fixture. Tests never touch the network. */
export function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
}

export function fixturePath(name) {
  return path.join(here, 'fixtures', name);
}

/** Deep clone so a test can mutate a fixture without affecting its neighbours. */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
