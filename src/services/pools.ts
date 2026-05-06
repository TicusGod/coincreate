import bs58 from 'bs58';
import { env } from '../config/env';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export { isSupabaseConfigured } from '../lib/supabase';
import type { PoolRow } from '../lib/types';
import type { UserPoolPosition } from './raydiumService';

/** Hardcoded SOL/USD for launch economics (AMM + card display); can swap for live oracle later. */
export const POOL_SOL_PRICE_USD = 180;

/** Fixed circulating supply assumption for headline MC (= price × supply). */
export const POOL_TOTAL_SUPPLY = 1_000_000_000;

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function randomBetween(min: number, max: number, decimals = 2): number {
  const v = min + Math.random() * (max - min);
  return Number(v.toFixed(decimals));
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function generateTokenInfoStats() {
  return {
    top_10_holders_pct: randomBetween(12, 28, 2),
    dev_holders_pct: randomBetween(0, 3, 2),
    snipers_pct: randomBetween(0, 5, 2),
    insiders_pct: randomBetween(5, 15, 2),
    bundlers_pct: randomBetween(0.5, 4, 2),
    lp_burned_pct: Math.random() < 0.85 ? 100 : randomBetween(85, 99, 2),
    holders_count: randomInt(150, 3500),
    pro_traders_count: randomInt(20, 500),
    dex_paid: Math.random() < 0.7,
    global_fees_paid: randomBetween(5, 200, 2),
  };
}

export function generateFakeSolanaPoolId(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bs58.encode(buf);
}

function normalizePoolRow(raw: Record<string, unknown>): PoolRow {
  return {
    pool_id: String(raw.pool_id ?? ''),
    token_symbol: String(raw.token_symbol ?? ''),
    token_name: String(raw.token_name ?? ''),
    token_address: String(raw.token_address ?? ''),
    token_image_url: raw.token_image_url == null ? null : String(raw.token_image_url),
    initial_sol_amount: num(raw.initial_sol_amount),
    initial_token_amount: num(raw.initial_token_amount),
    initial_market_cap_usd: num(raw.initial_market_cap_usd),
    initial_liquidity_usd: num(raw.initial_liquidity_usd),
    current_market_cap_usd: num(raw.current_market_cap_usd),
    current_liquidity_usd: num(raw.current_liquidity_usd),
    current_price_usd: num(raw.current_price_usd),
    current_supply:
      raw.current_supply === undefined || raw.current_supply === null
        ? num(raw.initial_token_amount)
        : num(raw.current_supply),
    ath_market_cap_usd: raw.ath_market_cap_usd === undefined ? num(raw.current_market_cap_usd) : num(raw.ath_market_cap_usd),
    is_simulation_active: Boolean(raw.is_simulation_active),
    simulation_started_at: raw.simulation_started_at == null ? null : String(raw.simulation_started_at),
    simulation_ends_at: raw.simulation_ends_at == null ? null : String(raw.simulation_ends_at),
    created_at: String(raw.created_at ?? ''),
    top_10_holders_pct: num(raw.top_10_holders_pct),
    dev_holders_pct: num(raw.dev_holders_pct),
    snipers_pct: num(raw.snipers_pct),
    insiders_pct: num(raw.insiders_pct),
    bundlers_pct: num(raw.bundlers_pct),
    lp_burned_pct: num(raw.lp_burned_pct),
    holders_count: Math.round(num(raw.holders_count)),
    pro_traders_count: Math.round(num(raw.pro_traders_count)),
    dex_paid: Boolean(raw.dex_paid),
    global_fees_paid: num(raw.global_fees_paid),
  };
}

export type CreatePoolInput = {
  /** When omitted, a random Solana-style base58 id is generated. */
  pool_id?: string;
  token_symbol: string;
  token_name: string;
  token_address: string;
  token_image_url: string | null;
  initial_sol_amount: number;
  initial_token_amount: number;
};

/**
 * Raydium-style 50/50 constant-product snapshot from deposit ratio:
 * price_usd = (sol × SOL_PRICE) / token_amount, MC = price × supply, liq = sol × SOL_PRICE × 2.
 */
export async function createPool(input: CreatePoolInput): Promise<PoolRow> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }
  const tokenAmt = input.initial_token_amount;
  if (!Number.isFinite(tokenAmt) || tokenAmt <= 0) {
    throw new Error('initial_token_amount must be a positive number');
  }
  const sol = Math.max(0, input.initial_sol_amount);
  const initialPriceUsd = (sol * POOL_SOL_PRICE_USD) / tokenAmt;
  const initialMarketCapUsd = initialPriceUsd * POOL_TOTAL_SUPPLY;
  const initialLiquidityUsd = sol * POOL_SOL_PRICE_USD * 2;

  const tokenStats = generateTokenInfoStats();

  const row = {
    pool_id: input.pool_id?.trim() || generateFakeSolanaPoolId(),
    token_symbol: input.token_symbol,
    token_name: input.token_name,
    token_address: input.token_address,
    token_image_url: input.token_image_url,
    initial_sol_amount: sol,
    initial_token_amount: tokenAmt,
    initial_market_cap_usd: initialMarketCapUsd,
    initial_liquidity_usd: initialLiquidityUsd,
    current_supply: tokenAmt,
    current_market_cap_usd: initialMarketCapUsd,
    current_liquidity_usd: initialLiquidityUsd,
    current_price_usd: initialPriceUsd,
    ath_market_cap_usd: initialMarketCapUsd,
    is_simulation_active: false,
    ...tokenStats,
  };

  const { data, error } = await getSupabase().from('pools').insert(row).select('*').single();

  if (error) throw error;
  return normalizePoolRow(data as Record<string, unknown>);
}

export async function listPools(): Promise<PoolRow[]> {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await getSupabase()
    .from('pools')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  if (!data?.length) return [];
  return (data as Record<string, unknown>[]).map(normalizePoolRow);
}

export async function deletePoolById(poolId: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const id = poolId.trim();
  if (!id) return;
  const { error } = await getSupabase().from('pools').delete().eq('pool_id', id);
  if (error) throw error;
}

export async function startSimulation(poolId: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const now = new Date();
  const ends = new Date(now.getTime() + 30 * 60 * 1000);
  const { error } = await getSupabase()
    .from('pools')
    .update({
      simulation_started_at: now.toISOString(),
      simulation_ends_at: ends.toISOString(),
      is_simulation_active: true,
    })
    .eq('pool_id', poolId)
    .eq('is_simulation_active', false);

  if (error) throw error;
}

export function getAxiomDevTokenUrl(poolId: string): string {
  const raw = import.meta.env.VITE_AXIOM_URL ?? 'http://localhost:3000';
  const base = String(raw).replace(/\/$/, '');
  return `${base}/token/${encodeURIComponent(poolId)}?simulate=1`;
}

/** Updates simulation flags when inactive, then opens axiom-dev for this pool id. */
export async function viewPoolOnAxiom(poolId: string): Promise<void> {
  await startSimulation(poolId);
  window.open(getAxiomDevTokenUrl(poolId), '_blank', 'noopener,noreferrer');
}

/** Maps a Supabase `pools` row to card display. Uses only `initial_*` — simulator-owned `current_*` must not affect “Your Pools”. */
export function poolRowToUserPoolPosition(row: PoolRow): UserPoolPosition {
  const solDeposit = row.initial_sol_amount;
  return {
    poolId: row.pool_id,
    baseMint: row.token_address,
    quoteMint: env.wsolMint,
    baseSymbol: row.token_symbol,
    quoteSymbol: 'SOL',
    lpMint: '',
    lpAmount: '0',
    lpAmountRaw: '0',
    sharePercent: 100,
    baseAmount: String(row.initial_token_amount),
    quoteAmount: String(solDeposit),
    baseUsdValue: 0,
    quoteUsdValue: 0,
    totalUsdValue: row.initial_liquidity_usd,
    totalSolEquivalent: solDeposit > 0 ? solDeposit : undefined,
    poolTvlUsd: row.initial_liquidity_usd,
    isDrained: false,
    isPromoPool: false,
    isSupabasePool: true,
  };
}
