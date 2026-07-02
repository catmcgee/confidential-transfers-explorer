import { NextRequest, NextResponse } from 'next/server';
import { signatureSchema, apiResponse, apiError } from '@ct-explorer/shared';
import { fetchTxFromIndexer } from '@/lib/indexer';
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

    let tx;
    try {
      tx = await fetchTxFromIndexer(sig);
    } catch {
      tx = null;
    }

    // Fall back to RPC if indexer doesn't have it
    if (!tx) {
      tx = await fetchTransactionDetailFromRpc(sig);
    }

    if (!tx || tx.activities.length === 0) {
      return NextResponse.json(apiError('Transaction not found', 'NOT_FOUND'), {
        status: 404,
      });
    }

    return NextResponse.json(apiResponse(tx));
  } catch (error) {
    console.error('[API] Transaction detail error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
