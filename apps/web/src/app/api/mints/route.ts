import { NextResponse } from 'next/server';
import { apiResponse, apiError } from '@ct-explorer/shared';
import type { MintsResponse } from '@ct-explorer/shared';
import { getMints } from '@/lib/db';

export async function GET() {
  try {
    const mints = await getMints();

    const response: MintsResponse = {
      mints: mints.map((m) => ({
        address: m.address,
        decimals: m.decimals,
        name: m.name,
        symbol: m.symbol,
      })),
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Mints error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
