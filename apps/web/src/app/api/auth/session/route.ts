import { NextResponse } from 'next/server';
import { apiResponse, apiError } from '@ct-explorer/shared';
import { getSession } from '@/lib/auth';

export async function GET() {
  try {
    const session = await getSession();

    if (!session) {
      return NextResponse.json(apiResponse({ authenticated: false }));
    }

    return NextResponse.json(
      apiResponse({
        authenticated: true,
        publicKey: session.publicKey,
        expiresAt: session.exp,
      })
    );
  } catch (error) {
    console.error('[API] Session error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
