'use client';

import { useState, useEffect, useCallback } from 'react';
import type { CTActivityResponse } from '@ct-explorer/shared';

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
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivity = useCallback(
    async (currentCursor?: number) => {
      try {
        const params = new URLSearchParams();
        params.set('limit', limit.toString());
        params.set('type', type);
        if (currentCursor) {
          params.set('cursor', currentCursor.toString());
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
      setIsLoading(true);
      setError(null);

      try {
        const result = await fetchActivity();
        setActivities(result.activities);
        setCursor(result.cursor);
        setHasMore(result.hasMore);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      } finally {
        setIsLoading(false);
      }
    };

    loadInitial();
  }, [fetchActivity]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoading) return;

    setIsLoading(true);
    try {
      const result = await fetchActivity(cursor);
      setActivities((prev) => [...prev, ...result.activities]);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setIsLoading(false);
    }
  }, [cursor, isLoading, fetchActivity]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchActivity();
      setActivities(result.activities);
      setCursor(result.cursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setIsLoading(false);
    }
  }, [fetchActivity]);

  return {
    activities,
    isLoading,
    error,
    hasMore,
    loadMore,
    refresh,
  };
}
