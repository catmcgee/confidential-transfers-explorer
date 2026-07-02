'use client';

import { useState, useEffect, useCallback } from 'react';
import type { CTActivityResponse } from '@ct-explorer/shared';

interface FeedCacheValue {
  activities: CTActivityResponse[];
  cursor: string | null;
  hasMore: boolean;
  timestamp: number;
}

// In-memory cache for initial feed pages so filter switches do not refetch immediately.
const feedCache = new Map<string, FeedCacheValue>();
const CACHE_TTL = 60000; // 1 minute

interface UseFeedOptions {
  type?: string;
  limit?: number;
  autoRefresh?: boolean;
  refreshInterval?: number;
  address?: string;
}

interface UseFeedResult {
  activities: CTActivityResponse[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  addOptimisticActivity: (activity: Partial<CTActivityResponse> & { signature: string }) => void;
}

export function useFeed(options: UseFeedOptions = {}): UseFeedResult {
  const { type = 'all', limit = 50, autoRefresh = false, refreshInterval = 30000, address } = options;

  const [activities, setActivities] = useState<CTActivityResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The API is always queried unfiltered ('all') and the type filter is
  // applied client-side. Server-side type filtering re-scans the chain per
  // filter with the same depth budget, so filtered tabs would surface fewer
  // items than are already visible in the 'All' tab — confusing and slower.
  const cacheKey = `feed:${address ?? 'global'}:${limit}`;

  const mergeActivities = useCallback((current: CTActivityResponse[], incoming: CTActivityResponse[]) => {
    const seenSignatures = new Set<string>();
    const merged: CTActivityResponse[] = [];

    for (const activity of [...current, ...incoming]) {
      if (seenSignatures.has(activity.signature)) continue;
      seenSignatures.add(activity.signature);
      merged.push(activity);
    }

    return merged;
  }, []);

  const fetchFeed = useCallback(
    async (currentCursor?: string) => {
      try {
        const params = new URLSearchParams();
        params.set('limit', limit.toString());
        params.set('type', 'all');
        if (currentCursor) {
          params.set('cursor', currentCursor);
        }
        if (address) {
          params.set('address', address);
        }

        const response = await fetch(`/api/feed?${params}`);
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || 'Failed to fetch feed');
        }

        return data.data;
      } catch (err) {
        throw err;
      }
    },
    [limit, address]
  );

  // Initial fetch
  useEffect(() => {
    const loadInitial = async () => {
      const cached = feedCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setActivities(cached.activities);
        setCursor(cached.cursor);
        setHasMore(cached.hasMore);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setActivities([]);

      try {
        const result = await fetchFeed();
        setActivities(result.activities);
        setCursor(result.cursor);
        setHasMore(result.hasMore);
        feedCache.set(cacheKey, {
          activities: result.activities,
          cursor: result.cursor,
          hasMore: result.hasMore,
          timestamp: Date.now(),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load feed');
      } finally {
        setIsLoading(false);
      }
    };

    loadInitial();
  }, [cacheKey, fetchFeed]);

  // Auto-refresh (skip for wallet-scoped activity to avoid pagination churn while testing)
  useEffect(() => {
    if (!autoRefresh || address) return;

    const interval = setInterval(async () => {
      try {
        const result = await fetchFeed();
        if (result.activities.length === 0) return;

        setActivities((prev) => {
          const merged = mergeActivities(result.activities, prev);
          feedCache.set(cacheKey, {
            activities: merged,
            cursor,
            hasMore,
            timestamp: Date.now(),
          });
          return merged;
        });
      } catch {
        // Silently fail on auto-refresh
      }
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [address, autoRefresh, cacheKey, cursor, fetchFeed, hasMore, mergeActivities, refreshInterval]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoading) return;

    setIsLoading(true);
    try {
      const result = await fetchFeed(cursor);
      setActivities((prev) => {
        const merged = mergeActivities(prev, result.activities);
        feedCache.set(cacheKey, {
          activities: merged,
          cursor: result.cursor,
          hasMore: result.hasMore,
          timestamp: Date.now(),
        });
        return merged;
      });
      setCursor(result.cursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setIsLoading(false);
    }
  }, [cacheKey, cursor, fetchFeed, hasMore, isLoading, mergeActivities]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchFeed();
      setActivities(result.activities);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
      feedCache.set(cacheKey, {
        activities: result.activities,
        cursor: result.cursor,
        hasMore: result.hasMore,
        timestamp: Date.now(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setIsLoading(false);
    }
  }, [cacheKey, fetchFeed]);

  // Add an optimistic activity to the top of the feed
  const addOptimisticActivity = useCallback(
    (activity: Partial<CTActivityResponse> & { signature: string }) => {
      feedCache.clear();
      const optimisticActivity: CTActivityResponse = {
        id: Date.now(),
        signature: activity.signature,
        blockTime: Math.floor(Date.now() / 1000),
        slot: 0,
        timestamp: new Date().toISOString(),
        mint: activity.mint || null,
        instructionType: activity.instructionType || 'Transfer',
        sourceOwner: activity.sourceOwner || null,
        destOwner: activity.destOwner || null,
        sourceTokenAccount: activity.sourceTokenAccount || null,
        destTokenAccount: activity.destTokenAccount || null,
        amount: activity.amount || 'confidential',
        ciphertextLo: activity.ciphertextLo || null,
        ciphertextHi: activity.ciphertextHi || null,
        isOptimistic: true,
      };

      setActivities((prev) => mergeActivities([optimisticActivity], prev));
    },
    [mergeActivities]
  );

  const filteredActivities =
    type === 'all'
      ? activities
      : activities.filter((activity) => activity.instructionType === type);

  return {
    activities: filteredActivities,
    isLoading,
    error,
    hasMore,
    loadMore,
    refresh,
    addOptimisticActivity,
  };
}
