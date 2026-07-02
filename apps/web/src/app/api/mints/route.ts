import { NextResponse } from 'next/server';
import { apiResponse, apiError } from '@ct-explorer/shared';
import type { MintsResponse } from '@ct-explorer/shared';
import { fetchMintsFromIndexer } from '@/lib/indexer';
import { fetchRecentMintsFromRpc } from '@/lib/rpc';

export async function GET() {
  try {
    let mints;
    try {
      mints = await fetchMintsFromIndexer();
    } catch {
      mints = await fetchRecentMintsFromRpc();
    }

    const response: MintsResponse = { mints };
    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Mints error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
