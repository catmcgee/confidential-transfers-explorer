import { NextRequest, NextResponse } from 'next/server';
import { signatureSchema, apiResponse, apiError } from '@ct-explorer/shared';
import type {
  CTActivityResponse,
  TransactionDetailResponse,
  RawInstructionSummary,
} from '@ct-explorer/shared';
import { getActivitiesBySignature } from '@/lib/db';

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

    // Get activities from database
    const activities = getActivitiesBySignature(sig);

    if (activities.length === 0) {
      return NextResponse.json(apiError('Transaction not found', 'NOT_FOUND'), {
        status: 404,
      });
    }

    const firstActivity = activities[0]!;

    // Transform to response format
    const transformedActivities: CTActivityResponse[] = activities.map((a) => ({
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

    // Build raw instruction summaries from stored data
    const rawInstructions: RawInstructionSummary[] = activities
      .filter((a) => a.instructionData)
      .map((a) => ({
        programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        data: a.instructionData!,
        accounts: [
          a.sourceTokenAccount,
          a.mint,
          a.destTokenAccount,
          a.sourceOwner,
          a.destOwner,
        ].filter((acc): acc is string => acc !== null),
      }));

    const response: TransactionDetailResponse = {
      signature: sig,
      slot: firstActivity.slot,
      blockTime: firstActivity.blockTime,
      timestamp: firstActivity.blockTime
        ? new Date(firstActivity.blockTime * 1000).toISOString()
        : null,
      activities: transformedActivities,
      rawInstructions,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Transaction detail error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
