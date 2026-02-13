import { NextRequest, NextResponse } from 'next/server';
import { addressQuerySchema, pubkeySchema, apiResponse, apiError } from '@ct-explorer/shared';
import type { CTActivityResponse, AddressActivityResponse } from '@ct-explorer/shared';
import { getActivityByAddress } from '@/lib/db';

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

    // Get activities from database
    const result = await getActivityByAddress(pubkey, limit, cursor, type);

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

    const response: AddressActivityResponse = {
      address: pubkey,
      activities,
      cursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Address activity error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
