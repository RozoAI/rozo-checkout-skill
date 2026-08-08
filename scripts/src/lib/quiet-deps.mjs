/**
 * Silence one specific, harmless startup warning.
 *
 * A transitive Solana dependency prints "bigint: Failed to load bindings, pure
 * JS will be used" whenever its optional native module is absent — which is
 * the normal case for an npx install. It is noise, not a problem, and it would
 * otherwise be the first thing a user sees.
 *
 * Scoped deliberately: only that exact message is dropped, and only via
 * console.warn. Everything else, including any real warning from the same
 * library, still reaches the user.
 */
const originalWarn = console.warn.bind(console);

console.warn = (...args) => {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith('bigint: Failed to load bindings')) return;
  originalWarn(...args);
};

/**
 * Same treatment for the `punycode` deprecation notice (DEP0040), which newer
 * Node versions emit because a transitive dependency still requires it. Node
 * prints warnings from its own 'warning' listener, so the listener is replaced
 * with one that drops exactly this notice and re-prints everything else in the
 * usual format.
 */
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  const isPunycodeDeprecation =
    warning?.name === 'DeprecationWarning' && /\bpunycode\b/.test(warning.message || '');
  if (isPunycodeDeprecation) return;
  const code = warning.code ? ` [${warning.code}]` : '';
  process.stderr.write(`(node) ${warning.name}${code}: ${warning.message}\n`);
});
