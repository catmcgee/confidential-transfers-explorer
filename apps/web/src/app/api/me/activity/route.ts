import { NextRequest, NextResponse } from 'next/server';
import { addressQuerySchema, apiResponse, apiError } from '@ct-explorer/shared';
import type { CTActivityResponse, UserActivityResponse } from '@ct-explorer/shared';
import { getSession } from '@/lib/auth';
import { getActivityByAddress } from '@/lib/db';

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

    // Get activities for the authenticated user
    const result = await getActivityByAddress(session.publicKey, limit, cursor, type);

    // Transform to response format
    const activities: CTActivityResponse[] = result.activities.map((a) => ({
      id: a.id,
      signature: a.signature,
      slot: a.slot,
      blockTime: a.blockTime,
      timestamp: a.blockTime ? new Date(a.blockTime * 1000).toISOString() : null,
      instructionType: a.instructionType,
      mint: a.mint,
      sourceOwner: a.sourceOwner,
      destOwner: a.destOwner,
      sourceTokenAccount: a.sourceTokenAccount,
      destTokenAccount: a.destTokenAccount,
      amount: a.publicAmount ? a.publicAmount : 'confidential',
      ciphertextLo: a.ciphertextLo,
      ciphertextHi: a.ciphertextHi,
    }));

    const response: UserActivityResponse = {
      publicKey: session.publicKey,
      activities,
      cursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] User activity error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
