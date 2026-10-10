/**
 * The published package version, read from package.json at runtime.
 *
 * This module is published bundled into scripts/dist/, one directory shallower
 * than its home at scripts/src/lib/, so package.json sits at a different depth
 * in the artifact than in the source tree. Hardcoding one depth resolves in the
 * source tree and throws in the published package, where the fallback would
 * then label every real user's request "0.0.0", silently, since the fallback
 * exists precisely so a missing package.json cannot stop a payment.
 *
 * Try both depths and require the name to match, so a stray package.json from
 * a parent directory can never supply the version.
 */

import { createRequire } from 'node:module';

export const PKG_VERSION = (() => {
  const requireFrom = createRequire(import.meta.url);
  for (const candidate of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = requireFrom(candidate);
      if (pkg?.name === '@rozoai/checkout' && pkg.version) return pkg.version;
    } catch {
      // Wrong depth for this layout; try the next.
    }
  }
  return '0.0.0';
})();
