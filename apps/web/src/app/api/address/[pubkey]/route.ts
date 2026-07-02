import { NextRequest, NextResponse } from 'next/server';
import { addressQuerySchema, pubkeySchema, apiResponse, apiError } from '@ct-explorer/shared';
import type { AddressActivityResponse } from '@ct-explorer/shared';
import { fetchActivityFromIndexer } from '@/lib/indexer';
import { fetchActivityPageFromRpc } from '@/lib/rpc';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ pubkey: string }> }
) {
  try {
    const { pubkey } = await params;

    // Validate pubkey
    const pubkeyResult = pubkeySchema.safeParse(pubkey);
    if (!pubkeyResult.success) {
      return NextResponse.json(apiError('Invalid address', 'INVALID_ADDRESS'), {
        status: 400,
      });
    }

    const searchParams = request.nextUrl.searchParams;

    // Parse and validate query params
    const parseResult = addressQuerySchema.safeParse({
      limit: searchParams.get('limit') ?? 50,
      cursor: searchParams.get('cursor') ?? undefined,
      type: searchParams.get('type') ?? 'all',
    });

    if (!parseResult.success) {
      return NextResponse.json(apiError('Invalid query parameters', 'INVALID_PARAMS'), {
        status: 400,
      });
    }

    const { limit, cursor, type } = parseResult.data;

    let result;
    try {
      result = await fetchActivityFromIndexer(pubkey, limit, cursor ?? null, type);
    } catch {
      result = await fetchActivityPageFromRpc(pubkey, limit, cursor ?? null, type);
    }

    const response: AddressActivityResponse = {
      address: pubkey,
      activities: result.activities,
      cursor: result.cursor,
      hasMore: result.hasMore,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Address activity error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
