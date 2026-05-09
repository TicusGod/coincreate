import type { SolanaNetwork } from '../config/env';

export function solanaExplorerAddressUrl(address: string, network: SolanaNetwork): string {
  const base = 'https://explorer.solana.com/address';
  const a = encodeURIComponent(address.trim());
  return network === 'devnet' ? `${base}/${a}?cluster=devnet` : `${base}/${a}`;
}

export function meteoraPoolUrl(poolAddress: string): string {
  return `https://app.meteora.ag/pools/${encodeURIComponent(poolAddress.trim())}`;
}

/** Dexscreener chart/analytics for a Solana pool or pair mint address. */
export function dexscreenerSolanaPoolUrl(poolAddress: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(poolAddress.trim())}`;
}
