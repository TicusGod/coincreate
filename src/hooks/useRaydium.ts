import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { type Commitment, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import { addLiquidity, getUserPools, removeLiquidity, resetRaydium, type UserPoolPosition } from '../services/raydiumService';
import type { QuoteCurrency } from '../utils/quoteCurrency';
import { useVisibilityAwareInterval } from './useVisibilityAwareInterval';

export function useRaydium() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [userPools, setUserPools] = useState<UserPoolPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshUserPools = useCallback(
    async (commitment: Commitment = 'confirmed') => {
      if (!wallet.publicKey) {
        setUserPools([]);
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        setUserPools(await getUserPools(connection, wallet.publicKey, commitment));
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

  useVisibilityAwareInterval(refreshUserPools, 60_000, wallet.connected);

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
