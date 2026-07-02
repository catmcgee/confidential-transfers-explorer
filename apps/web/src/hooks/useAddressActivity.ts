'use client';

import { useState, useEffect, useCallback } from 'react';
import type { CTActivityResponse } from '@ct-explorer/shared';

interface AddressActivityCacheValue {
  activities: CTActivityResponse[];
  cursor: string | null;
  hasMore: boolean;
  timestamp: number;
}

const activityCache = new Map<string, AddressActivityCacheValue>();
const CACHE_TTL = 60000;

interface UseAddressActivityOptions {
  address: string;
  type?: string;
  limit?: number;
}

interface UseAddressActivityResult {
  activities: CTActivityResponse[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAddressActivity(options: UseAddressActivityOptions): UseAddressActivityResult {
  const { address, type = 'all', limit = 50 } = options;

  const [activities, setActivities] = useState<CTActivityResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cacheKey = `address:${address}:${type}:${limit}`;

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

  const fetchActivity = useCallback(
    async (currentCursor?: string) => {
      try {
        const params = new URLSearchParams();
        params.set('limit', limit.toString());
        params.set('type', type);
        if (currentCursor) {
          params.set('cursor', currentCursor);
        }

        const response = await fetch(`/api/address/${address}?${params}`);
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || 'Failed to fetch activity');
        }

        return data.data;
      } catch (err) {
        throw err;
      }
    },
    [address, limit, type]
  );

  // Initial fetch
  useEffect(() => {
    const loadInitial = async () => {
      const cached = activityCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setActivities(cached.activities);
        setCursor(cached.cursor);
        setHasMore(cached.hasMore);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const result = await fetchActivity();
        setActivities(result.activities);
        setCursor(result.cursor);
        setHasMore(result.hasMore);
        activityCache.set(cacheKey, {
          activities: result.activities,
          cursor: result.cursor,
          hasMore: result.hasMore,
          timestamp: Date.now(),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      } finally {
        setIsLoading(false);
      }
    };

    loadInitial();
  }, [cacheKey, fetchActivity]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoading) return;

    setIsLoading(true);
    try {
      const result = await fetchActivity(cursor);
      setActivities((prev) => {
        const merged = mergeActivities(prev, result.activities);
        activityCache.set(cacheKey, {
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
  }, [cacheKey, cursor, fetchActivity, isLoading, mergeActivities]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchActivity();
      setActivities(result.activities);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
      activityCache.set(cacheKey, {
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
  }, [cacheKey, fetchActivity]);

  return {
    activities,
    isLoading,
    error,
    hasMore,
    loadMore,
    refresh,
  };
}
