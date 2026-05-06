import bs58 from 'bs58';
import { env } from '../config/env';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export { isSupabaseConfigured } from '../lib/supabase';
import type { PoolRow } from '../lib/types';
import type { UserPoolPosition } from './raydiumService';

/** Hardcoded SOL/USD for demo pool economics (per product spec). */
export const POOL_SOL_PRICE_USD = 180;

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
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
    is_simulation_active: Boolean(raw.is_simulation_active),
    simulation_started_at: raw.simulation_started_at == null ? null : String(raw.simulation_started_at),
    simulation_ends_at: raw.simulation_ends_at == null ? null : String(raw.simulation_ends_at),
    created_at: String(raw.created_at ?? ''),
  };
}

export type CreatePoolInput = {
  token_symbol: string;
  token_name: string;
  token_address: string;
  token_image_url: string | null;
  initial_sol_amount: number;
  initial_token_amount: number;
};

export async function createPool(input: CreatePoolInput): Promise<PoolRow> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }
  const initialLiquidityUsd = input.initial_sol_amount * POOL_SOL_PRICE_USD * 2;
  const initialMarketCapUsd = input.initial_sol_amount * POOL_SOL_PRICE_USD * 2;
  const currentPriceUsd = initialMarketCapUsd / 1_000_000_000;

  const row = {
    pool_id: generateFakeSolanaPoolId(),
    token_symbol: input.token_symbol,
    token_name: input.token_name,
    token_address: input.token_address,
    token_image_url: input.token_image_url,
    initial_sol_amount: input.initial_sol_amount,
    initial_token_amount: input.initial_token_amount,
    initial_market_cap_usd: initialMarketCapUsd,
    initial_liquidity_usd: initialLiquidityUsd,
    current_market_cap_usd: initialMarketCapUsd,
    current_liquidity_usd: initialLiquidityUsd,
    current_price_usd: currentPriceUsd,
    is_simulation_active: false,
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
  return `${base}/token/${encodeURIComponent(poolId)}`;
}

/** Updates simulation flags when inactive, then opens axiom-dev for this pool id. */
export async function viewPoolOnAxiom(poolId: string): Promise<void> {
  await startSimulation(poolId);
  window.open(getAxiomDevTokenUrl(poolId), '_blank', 'noopener,noreferrer');
}

export function poolRowToUserPoolPosition(row: PoolRow): UserPoolPosition {
  const pooledSolUi = row.current_liquidity_usd / POOL_SOL_PRICE_USD / 2;
  const solUsd = POOL_SOL_PRICE_USD;
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
    quoteAmount: String(pooledSolUi),
    baseUsdValue: 0,
    quoteUsdValue: 0,
    totalUsdValue: row.current_liquidity_usd,
    totalSolEquivalent: solUsd > 0 ? row.current_liquidity_usd / solUsd : undefined,
    poolTvlUsd: row.current_liquidity_usd,
    isDrained: false,
    isPromoPool: false,
  };
}
