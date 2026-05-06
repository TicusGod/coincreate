import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { type Commitment, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { addLiquidity, getUserPools, removeLiquidity, resetRaydium, type UserPoolPosition } from '../services/raydiumService';
import { isSupabaseConfigured, listPools, poolRowToUserPoolPosition } from '../services/pools';
import type { QuoteCurrency } from '../utils/quoteCurrency';
import { useVisibilityAwareInterval } from './useVisibilityAwareInterval';
import { mergePromoPoolsWithRaydium } from '../promoPools';

export function useRaydium() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [userPools, setUserPools] = useState<UserPoolPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshUserPools = useCallback(
    async (commitment: Commitment = 'confirmed') => {
      setIsLoading(true);
      setError(null);
      try {
        if (isSupabaseConfigured()) {
          const rows = await listPools();
          setUserPools(rows.map(poolRowToUserPoolPosition));
          return;
        }
        if (!wallet.publicKey) {
          setUserPools([]);
          return;
        }
        setUserPools(await mergePromoPoolsWithRaydium(wallet.publicKey, await getUserPools(connection, wallet.publicKey, commitment)));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load pools');
      } finally {
        setIsLoading(false);
      }
    },
    [connection, wallet.publicKey],
  );

  useEffect(() => {
    void refreshUserPools();
  }, [refreshUserPools]);

  // Supabase-backed “Your Pools” are deposit snapshots (`initial_*`): no periodic refetch (simulator touches `current_*`).
  useVisibilityAwareInterval(refreshUserPools, 60_000, wallet.connected && !isSupabaseConfigured());

  useEffect(() => {
    if (!wallet.connected) resetRaydium();
  }, [wallet.connected, wallet.publicKey]);

  const add = useCallback(
    async (p: {
      baseMint: string;
      quoteCurrency: QuoteCurrency;
      baseAmount: string | number;
      quoteAmount: string | number;
      slippagePercent?: number;
    }) => {
      if (!wallet.publicKey) throw new Error('Connect wallet');
      const result = await addLiquidity({
        connection,
        wallet,
        baseMint: new PublicKey(p.baseMint),
        quoteCurrency: p.quoteCurrency,
        baseAmount: p.baseAmount,
        quoteAmount: p.quoteAmount,
        slippagePercent: p.slippagePercent ?? 1,
      });
      resetRaydium();
      await refreshUserPools('confirmed');
      return result;
    },
    [connection, wallet, refreshUserPools],
  );

  const remove = useCallback(
    async (p: { poolId: string; lpAmountRaw: string; slippagePercent?: number }) => {
      if (!wallet.publicKey) throw new Error('Connect wallet');
      const result = await removeLiquidity({
        connection,
        wallet,
        poolId: p.poolId,
        lpAmountRaw: p.lpAmountRaw,
        slippagePercent: p.slippagePercent ?? 1,
      });
      resetRaydium();
      await refreshUserPools('confirmed');
      return result;
    },
    [connection, wallet, refreshUserPools],
  );

  return {
    addLiquidity: add,
    removeLiquidity: remove,
    userPools,
    refreshUserPools,
    isLoading,
    error,
  };
}
