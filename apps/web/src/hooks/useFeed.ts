'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CTActivityResponse } from '@ct-explorer/shared';

// In-memory cache for RPC-based address queries (survives filter switches)
const addressCache = new Map<string, { activities: CTActivityResponse[]; timestamp: number }>();
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
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFeed = useCallback(
    async (currentCursor?: number) => {
      try {
        const params = new URLSearchParams();
        params.set('limit', limit.toString());
        params.set('type', type);
        if (currentCursor) {
          params.set('cursor', currentCursor.toString());
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
    [limit, type, address]
  );

  // Initial fetch
  useEffect(() => {
    const loadInitial = async () => {
      // Check cache for address queries
      if (address) {
        const cached = addressCache.get(address);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          setActivities(cached.activities);
          setCursor(null);
          setHasMore(false);
          setIsLoading(false);
          return;
        }
      }

      setIsLoading(true);
      setError(null);
      setActivities([]); // Clear stale data while loading

      try {
        const result = await fetchFeed();
        setActivities(result.activities);
        setCursor(result.cursor);
        setHasMore(result.hasMore);
        // Cache address query results
        if (address) {
          addressCache.set(address, { activities: result.activities, timestamp: Date.now() });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load feed');
      } finally {
        setIsLoading(false);
      }
    };

    loadInitial();
  }, [fetchFeed, address]);

  // Auto-refresh (skip for RPC-based address queries to avoid duplicates)
  useEffect(() => {
    if (!autoRefresh || address) return;

    const interval = setInterval(async () => {
      try {
        const result = await fetchFeed();
        // Only update if we have new activities
        if (result.activities.length > 0) {
          const existingSigs = new Set(activities.map((a) => a.signature));
          const newActivities = result.activities.filter(
            (a: CTActivityResponse) => !existingSigs.has(a.signature)
          );
          if (newActivities.length > 0) {
            setActivities((prev) => [...newActivities, ...prev]);
          }
        }
      } catch {
        // Silently fail on auto-refresh
      }
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, fetchFeed, activities, address]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoading) return;

    setIsLoading(true);
    try {
      const result = await fetchFeed(cursor);
      setActivities((prev) => [...prev, ...result.activities]);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setIsLoading(false);
    }
  }, [cursor, isLoading, fetchFeed]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchFeed();
      setActivities(result.activities);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setIsLoading(false);
    }
  }, [fetchFeed]);

  // Add an optimistic activity to the top of the feed
  const addOptimisticActivity = useCallback(
    (activity: Partial<CTActivityResponse> & { signature: string }) => {
      // Invalidate address cache so Mine tab refreshes
      addressCache.clear();
      const optimisticActivity: CTActivityResponse = {
        id: Date.now(), // Temporary ID
        signature: activity.signature,
        blockTime: Math.floor(Date.now() / 1000),
        slot: 0,
        timestamp: new Date().toISOString(),
        mint: activity.mint || null,
        instructionType: activity.instructionType || 'ConfidentialTransfer',
        sourceOwner: activity.sourceOwner || null,
        destOwner: activity.destOwner || null,
        sourceTokenAccount: activity.sourceTokenAccount || null,
        destTokenAccount: activity.destTokenAccount || null,
        amount: activity.amount || 'confidential',
        ciphertextLo: activity.ciphertextLo || null,
        ciphertextHi: activity.ciphertextHi || null,
        isOptimistic: true, // Flag to show pending state in UI
      };

      setActivities((prev) => [optimisticActivity, ...prev]);
    },
    []
  );

  return {
    activities,
    isLoading,
    error,
    hasMore,
    loadMore,
    refresh,
    addOptimisticActivity,
  };
}
