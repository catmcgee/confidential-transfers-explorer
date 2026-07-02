import { NextRequest, NextResponse } from 'next/server';
import { addressQuerySchema, apiResponse, apiError } from '@ct-explorer/shared';
import type { UserActivityResponse } from '@ct-explorer/shared';
import { getSession } from '@/lib/auth';
import { fetchActivityFromIndexer } from '@/lib/indexer';
import { fetchActivityPageFromRpc } from '@/lib/rpc';

export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const session = await getSession();
    if (!session) {
      return NextResponse.json(apiError('Unauthorized', 'UNAUTHORIZED'), {
        status: 401,
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
      result = await fetchActivityFromIndexer(session.publicKey, limit, cursor ?? null, type);
    } catch {
      result = await fetchActivityPageFromRpc(session.publicKey, limit, cursor ?? null, type);
    }

    const response: UserActivityResponse = {
      publicKey: session.publicKey,
      activities: result.activities,
      cursor: result.cursor,
      hasMore: result.hasMore,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] User activity error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
