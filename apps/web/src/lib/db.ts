import type { CTActivityRecord, TokenAccountRecord, MintRecord } from '@ct-explorer/shared';

// Indexer API URL — uses Railway private networking in production
const INDEXER_URL = process.env['INDEXER_URL'] || 'http://localhost:3001';

async function indexerFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${INDEXER_URL}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// Activity queries
export async function getFeed(
  limit: number,
  cursor?: number,
  type?: string
): Promise<{ activities: CTActivityRecord[]; nextCursor: number | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  if (type) params.set('type', type);

  const result = await indexerFetch<{ activities: CTActivityRecord[]; nextCursor: number | null }>(
    `/api/feed?${params}`
  );
  return result ?? { activities: [], nextCursor: null };
}

export async function getActivityByAddress(
  address: string,
  limit: number,
  cursor?: number,
  type?: string
): Promise<{ activities: CTActivityRecord[]; nextCursor: number | null }> {
  const params = new URLSearchParams({ address, limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  if (type) params.set('type', type);

  const result = await indexerFetch<{ activities: CTActivityRecord[]; nextCursor: number | null }>(
    `/api/activity?${params}`
  );
  return result ?? { activities: [], nextCursor: null };
}

export async function getActivitiesBySignature(signature: string): Promise<CTActivityRecord[]> {
  const result = await indexerFetch<{ activities: CTActivityRecord[] }>(
    `/api/tx?signature=${encodeURIComponent(signature)}`
  );
  return result?.activities ?? [];
}

export async function getMints(): Promise<MintRecord[]> {
  const result = await indexerFetch<{ mints: MintRecord[] }>('/api/mints');
  return result?.mints ?? [];
}

export async function getMint(address: string): Promise<MintRecord | null> {
  const result = await indexerFetch<{ mint: MintRecord | null }>(
    `/api/mint?address=${encodeURIComponent(address)}`
  );
  return result?.mint ?? null;
}

export async function getTokenAccountsByOwner(owner: string): Promise<TokenAccountRecord[]> {
  const result = await indexerFetch<{ accounts: TokenAccountRecord[] }>(
    `/api/token-accounts?owner=${encodeURIComponent(owner)}`
  );
  return result?.accounts ?? [];
}

export async function search(query: string, limit: number = 10): Promise<CTActivityRecord[]> {
  const result = await indexerFetch<{ activities: CTActivityRecord[] }>(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`
  );
  return result?.activities ?? [];
}
