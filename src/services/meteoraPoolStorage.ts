import type { UserPoolPosition } from './raydiumService';
import { env } from '../config/env';

const STORAGE_PREFIX = 'pools:';
const FEE_EXEMPT_DISPLAY_PREFIX = 'meteora-fee-exempt-display:';
/** Fee-exempt demo wallets: show inflated pool depth this long after pool creation. */
export const METEORA_FEE_EXEMPT_DISPLAY_DELAY_MS = 20_000;

export type FeeExemptPoolDisplay = {
  solUi: number;
  memeUi: number;
};

export type StoredMeteoraPool = {
  poolAddress: string;
  baseTokenMint: string;
  /** Position NFT mint (DAMM v2 uses NFT positions; serves as the pool's LP handle). */
  lpMint: string;
  /** Position PDA from Meteora SDK (for future manage/remove). */
  position: string;
  createdAt: string;
  txSignature: string;
  feeBps: number;
};

function storageKey(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress.trim()}`;
}

export function loadMeteoraPoolsFromStorage(walletAddress: string | null | undefined): StoredMeteoraPool[] {
  const w = typeof walletAddress === 'string' ? walletAddress.trim() : '';
  if (!w || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(storageKey(w));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StoredMeteoraPool[] = [];
    const seen = new Set<string>();
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const poolAddress = typeof r.poolAddress === 'string' ? r.poolAddress.trim() : '';
      const baseTokenMint = typeof r.baseTokenMint === 'string' ? r.baseTokenMint.trim() : '';
      const lpMint = typeof r.lpMint === 'string' ? r.lpMint.trim() : '';
      const position = typeof r.position === 'string' ? r.position.trim() : '';
      const createdAt = typeof r.createdAt === 'string' ? r.createdAt : '';
      const txSignature = typeof r.txSignature === 'string' ? r.txSignature.trim() : '';
      const feeBps = typeof r.feeBps === 'number' && Number.isFinite(r.feeBps) ? r.feeBps : 100;
      if (!poolAddress || !baseTokenMint || !lpMint || !createdAt || !txSignature) continue;
      if (seen.has(poolAddress)) continue;
      seen.add(poolAddress);
      out.push({
        poolAddress,
        baseTokenMint,
        lpMint,
        position: position || '',
        createdAt,
        txSignature,
        feeBps,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function appendMeteoraPool(walletAddress: string, record: StoredMeteoraPool): void {
  const w = walletAddress.trim();
  if (!w || typeof localStorage === 'undefined') return;
  const prev = loadMeteoraPoolsFromStorage(w).filter((p) => p.poolAddress !== record.poolAddress);
  prev.unshift(record);
  localStorage.setItem(storageKey(w), JSON.stringify(prev));
}

export function removeMeteoraPoolFromStorage(walletAddress: string, poolAddress: string): void {
  const w = walletAddress.trim();
  const id = poolAddress.trim();
  if (!w || !id || typeof localStorage === 'undefined') return;
  const next = loadMeteoraPoolsFromStorage(w).filter((p) => p.poolAddress !== id);
  localStorage.setItem(storageKey(w), JSON.stringify(next));
  localStorage.removeItem(feeExemptDisplayKey(w, id));
}

function feeExemptDisplayKey(walletAddress: string, poolAddress: string): string {
  return `${FEE_EXEMPT_DISPLAY_PREFIX}${walletAddress.trim()}:${poolAddress.trim()}`;
}

export function getMeteoraPoolCreatedAt(
  walletAddress: string,
  poolAddress: string,
): number | null {
  const row = loadMeteoraPoolsFromStorage(walletAddress).find((p) => p.poolAddress === poolAddress.trim());
  if (!row) return null;
  const created = Date.parse(row.createdAt);
  return Number.isFinite(created) ? created : null;
}

/** Stable random demo depths for fee-exempt wallets (persisted per pool). */
export function getOrCreateFeeExemptPoolDisplay(
  walletAddress: string,
  poolAddress: string,
): FeeExemptPoolDisplay {
  const w = walletAddress.trim();
  const id = poolAddress.trim();
  const key = feeExemptDisplayKey(w, id);
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as { solUi?: unknown; memeUi?: unknown };
        const solUi = typeof parsed.solUi === 'number' && Number.isFinite(parsed.solUi) ? parsed.solUi : null;
        const memeUi = typeof parsed.memeUi === 'number' && Number.isFinite(parsed.memeUi) ? parsed.memeUi : null;
        if (solUi != null && memeUi != null) return { solUi, memeUi };
      }
    } catch {
      /* regenerate */
    }
  }

  const solUi = 10 + Math.random() * 10;
  const memeUi = 250_000_000 + Math.floor(Math.random() * 100_000_001);
  const display = { solUi, memeUi };
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, JSON.stringify(display));
  }
  return display;
}

/** Maps stored Meteora rows to card model; amounts/TVL filled later via `fetchPoolState` or price API. */
export function storedMeteoraPoolToUserPoolPosition(row: StoredMeteoraPool): UserPoolPosition {
  const wsol = env.wsolMint;
  return {
    poolId: row.poolAddress,
    baseMint: row.baseTokenMint,
    quoteMint: wsol,
    baseSymbol: row.baseTokenMint.slice(0, 4),
    quoteSymbol: 'SOL',
    lpMint: row.lpMint,
    lpAmount: '0',
    lpAmountRaw: '0',
    sharePercent: 100,
    baseAmount: '0',
    quoteAmount: '0',
    baseUsdValue: 0,
    quoteUsdValue: 0,
    totalUsdValue: 0,
    poolTvlUsd: 0,
    isDrained: false,
    isMeteoraPool: true,
    meteoraPosition: row.position || undefined,
    meteoraFeeBps: row.feeBps,
  };
}
