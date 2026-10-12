/**
 * Public RPC endpoints, shared by the --send paths and the optional native
 * balance check. ROZO_CHECKOUT_RPC_<chainId> overrides any of them, and the
 * send scripts also take --rpc. Every send verifies the RPC's chain (EVM chain
 * id, Solana genesis hash) before signing, so a wrong endpoint fails closed.
 */

import { SkillError } from './output.mjs';

export const DEFAULT_RPC = Object.freeze({
  // eth.llamarpc.com and polygon-rpc.com stopped answering (checked
  // 2026-10-12: HTTP 525, and "API key disabled"); publicnode serves both.
  1: 'https://ethereum-rpc.publicnode.com',
  56: 'https://bsc-dataseed.binance.org',
  137: 'https://polygon-bor-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  900: 'https://api.mainnet-beta.solana.com',
});

/**
 * RPC URL for a chain: an explicit override, else ROZO_CHECKOUT_RPC_<id>,
 * else the default. Throws NO_RPC for a chain with none of them.
 */
export function rpcFor(chainId, override, env = process.env) {
  if (override && override !== true) return String(override);
  const fromEnv = env?.[`ROZO_CHECKOUT_RPC_${chainId}`];
  if (fromEnv) return fromEnv;
  const fallback = DEFAULT_RPC[String(chainId)];
  if (!fallback) {
    throw new SkillError(
      'NO_RPC',
      `No RPC known for chain ${chainId}. Pass --rpc <url> or set ROZO_CHECKOUT_RPC_${chainId}.`,
    );
  }
  return fallback;
}
