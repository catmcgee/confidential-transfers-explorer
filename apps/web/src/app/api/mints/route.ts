import { NextResponse } from 'next/server';
import { apiResponse, apiError } from '@ct-explorer/shared';
import type { MintsResponse } from '@ct-explorer/shared';
import { fetchRecentMintsFromRpc } from '@/lib/rpc';

export async function GET() {
  try {
    const mints = await fetchRecentMintsFromRpc();

    const response: MintsResponse = { mints };
    return NextResponse.json(apiResponse(response), {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
      },
    });
  } catch (error) {
    console.error('[API] Mints error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
