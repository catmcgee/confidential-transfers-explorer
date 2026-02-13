import { NextResponse } from 'next/server';
import { apiResponse, apiError } from '@ct-explorer/shared';
import type { UserBalancesResponse, UserTokenAccountInfo } from '@ct-explorer/shared';
import { getSession } from '@/lib/auth';
import { getTokenAccountsByOwner, getMint } from '@/lib/db';

export async function GET() {
  try {
    // Verify authentication
    const session = await getSession();
    if (!session) {
      return NextResponse.json(apiError('Unauthorized', 'UNAUTHORIZED'), {
        status: 401,
      });
    }

    // Get token accounts owned by the user
    const tokenAccounts = await getTokenAccountsByOwner(session.publicKey);

    // Build response with mint info
    const accountInfo: UserTokenAccountInfo[] = await Promise.all(tokenAccounts.map(async (account) => {
      const mint = await getMint(account.mint);

      return {
        address: account.address,
        mint: account.mint,
        mintDecimals: mint?.decimals ?? 9,
        mintName: mint?.name ?? null,
        mintSymbol: mint?.symbol ?? null,
        // Encrypted balance fields - actual values would need to be fetched from chain
        // These are placeholders; client-side decryption happens with user's keys
        pendingBalanceLo: 'encrypted',
        pendingBalanceHi: 'encrypted',
        availableBalance: 'encrypted',
        publicBalance: null, // Would need RPC call to get actual value
      };
    }));

    const response: UserBalancesResponse = {
      publicKey: session.publicKey,
      tokenAccounts: accountInfo,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] User balances error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
