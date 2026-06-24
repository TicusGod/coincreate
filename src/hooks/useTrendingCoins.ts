import { useCallback, useEffect, useState } from 'react';
import { getDexScreenerCoins, type DexScreenerCoin } from '../services/dexScreenerService';
import { useVisibilityAwareInterval } from './useVisibilityAwareInterval';

export function useTrendingCoins(tab: 'trending' | 'new') {
  const [coins, setCoins] = useState<DexScreenerCoin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (opts?: { force?: boolean }) => {
    const force = opts?.force ?? false;
    setLoading(true);
    setError(null);
    try {
      const list = await getDexScreenerCoins({ tab, limit: 24, force });
      setCoins(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setCoins([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useVisibilityAwareInterval(load, 60_000, true);

  return { coins, loading, error, refetch: () => load({ force: true }) };
}
