import { NextResponse } from 'next/server';
import { apiResponse, apiError } from '@ct-explorer/shared';
import type { UserBalancesResponse } from '@ct-explorer/shared';
import { getSession } from '@/lib/auth';
import { fetchUserTokenAccountsFromRpc } from '@/lib/rpc';

export async function GET() {
  try {
    // Verify authentication
    const session = await getSession();
    if (!session) {
      return NextResponse.json(apiError('Unauthorized', 'UNAUTHORIZED'), {
        status: 401,
      });
    }

    const tokenAccounts = await fetchUserTokenAccountsFromRpc(session.publicKey);

    const response: UserBalancesResponse = {
      publicKey: session.publicKey,
      tokenAccounts,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] User balances error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
