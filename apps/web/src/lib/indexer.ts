/**
 * Client for the CT Explorer indexer API.
 * Falls back to direct RPC when the indexer is unavailable.
 */

import type {
  CTActivityResponse,
  CTActivityRecord,
  FeedResponse,
  AddressActivityResponse,
  TransactionDetailResponse,
  MintInfo,
} from '@ct-explorer/shared';

const INDEXER_URL = process.env['INDEXER_URL'] || 'http://localhost:3001';
const INDEXER_TIMEOUT_MS = 5_000;

function recordToResponse(record: CTActivityRecord): CTActivityResponse {
  return {
    id: record.id,
    signature: record.signature,
    slot: record.slot,
    blockTime: record.blockTime,
    timestamp: typeof record.blockTime === 'number'
      ? new Date(record.blockTime * 1000).toISOString()
      : null,
    instructionType: record.instructionType,
    mint: record.mint,
    sourceOwner: record.sourceOwner,
    destOwner: record.destOwner,
    sourceTokenAccount: record.sourceTokenAccount,
    destTokenAccount: record.destTokenAccount,
    amount:
      (record.instructionType === 'Deposit' || record.instructionType === 'Withdraw')
        ? record.publicAmount ?? 'confidential'
        : 'confidential',
    ciphertextLo: record.ciphertextLo,
    ciphertextHi: record.ciphertextHi,
  };
}

async function indexerFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${INDEXER_URL}${path}`, {
    signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Indexer ${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchFeedFromIndexer(
  limit: number,
  cursor: string | null,
  type: string
): Promise<FeedResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  if (type && type !== 'all') params.set('type', type);

  const data = await indexerFetch<{
    activities: CTActivityRecord[];
    nextCursor: number | null;
  }>(`/api/feed?${params}`);

  return {
    activities: data.activities.map(recordToResponse),
    cursor: data.nextCursor != null ? String(data.nextCursor) : null,
    hasMore: data.nextCursor != null,
  };
}

export async function fetchActivityFromIndexer(
  address: string,
  limit: number,
  cursor: string | null,
  type: string
): Promise<{ activities: CTActivityResponse[]; cursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams({ address, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  if (type && type !== 'all') params.set('type', type);

  const data = await indexerFetch<{
    activities: CTActivityRecord[];
    nextCursor: number | null;
  }>(`/api/activity?${params}`);

  return {
    activities: data.activities.map(recordToResponse),
    cursor: data.nextCursor != null ? String(data.nextCursor) : null,
    hasMore: data.nextCursor != null,
  };
}

export async function fetchTxFromIndexer(
  signature: string
): Promise<TransactionDetailResponse | null> {
  const data = await indexerFetch<{
    activities: CTActivityRecord[];
  }>(`/api/tx?signature=${signature}`);

  if (!data.activities || data.activities.length === 0) return null;

  const first = data.activities[0]!;
  return {
    signature,
    slot: first.slot,
    blockTime: first.blockTime,
    timestamp: typeof first.blockTime === 'number'
      ? new Date(first.blockTime * 1000).toISOString()
      : null,
    activities: data.activities.map(recordToResponse),
    rawInstructions: [],
  };
}

export async function fetchMintsFromIndexer(): Promise<MintInfo[]> {
  const data = await indexerFetch<{
    mints: Array<{ address: string; decimals: number; name: string | null; symbol: string | null }>;
  }>('/api/mints');

  return data.mints.map((m) => ({
    address: m.address,
    decimals: m.decimals,
    name: m.name,
    symbol: m.symbol,
  }));
}

export async function isIndexerAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${INDEXER_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
