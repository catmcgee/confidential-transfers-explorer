import { NextRequest, NextResponse } from 'next/server';
import { signatureSchema, apiResponse, apiError } from '@ct-explorer/shared';
import { fetchTransactionDetailFromRpc } from '@/lib/rpc';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sig: string }> }
) {
  try {
    const { sig } = await params;

    // Validate signature
    const sigResult = signatureSchema.safeParse(sig);
    if (!sigResult.success) {
      return NextResponse.json(apiError('Invalid transaction signature', 'INVALID_SIGNATURE'), {
        status: 400,
      });
    }

    const tx = await fetchTransactionDetailFromRpc(sig);

    if (!tx || tx.activities.length === 0) {
      return NextResponse.json(apiError('Transaction not found', 'NOT_FOUND'), {
        status: 404,
      });
    }

    // Confirmed transactions are immutable — cache aggressively at the CDN.
    return NextResponse.json(apiResponse(tx), {
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (error) {
    console.error('[API] Transaction detail error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
