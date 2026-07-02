import { NextRequest, NextResponse } from 'next/server';
import { feedQuerySchema, pubkeySchema, apiResponse, apiError } from '@ct-explorer/shared';
import type { FeedResponse } from '@ct-explorer/shared';
import { fetchFeedFromIndexer, fetchActivityFromIndexer } from '@/lib/indexer';
import { fetchActivityPageFromRpc, fetchFeedPageFromRpc } from '@/lib/rpc';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const address = searchParams.get('address');

    // Parse and validate query params
    const parseResult = feedQuerySchema.safeParse({
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

    if (address) {
      const addressResult = pubkeySchema.safeParse(address);
      if (!addressResult.success) {
        return NextResponse.json(apiError('Invalid address', 'INVALID_ADDRESS'), {
          status: 400,
        });
      }

      let result;
      try {
        result = await fetchActivityFromIndexer(address, limit, cursor ?? null, type);
      } catch {
        result = await fetchActivityPageFromRpc(address, limit, cursor ?? null, type);
      }

      const response: FeedResponse = {
        activities: result.activities,
        cursor: result.cursor,
        hasMore: result.hasMore,
      };
      return NextResponse.json(apiResponse(response));
    }

    let result;
    try {
      result = await fetchFeedFromIndexer(limit, cursor ?? null, type);
    } catch {
      result = await fetchFeedPageFromRpc(limit, cursor ?? null, type);
    }

    const response: FeedResponse = {
      activities: result.activities,
      cursor: result.cursor,
      hasMore: result.hasMore,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Feed error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
