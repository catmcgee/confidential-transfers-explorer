import { NextRequest, NextResponse } from 'next/server';
import { loginRequestSchema, apiResponse, apiError } from '@ct-explorer/shared';
import type { LoginResponse } from '@ct-explorer/shared';
import { createSessionToken, setSessionCookie, verifySignature } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Parse and validate request
    const parseResult = loginRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(apiError('Invalid login request', 'INVALID_REQUEST'), {
        status: 400,
      });
    }

    const { publicKey, signature, message } = parseResult.data;

    // Verify the message format (should include timestamp)
    const messagePattern = /^Confidential Explorer Login: \d+$/;
    if (!messagePattern.test(message)) {
      return NextResponse.json(apiError('Invalid message format', 'INVALID_MESSAGE'), {
        status: 400,
      });
    }

    // Extract timestamp and verify it's recent (within 5 minutes)
    const timestamp = parseInt(message.split(': ')[1]!, 10);
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    if (Math.abs(now - timestamp) > fiveMinutes) {
      return NextResponse.json(apiError('Message expired', 'MESSAGE_EXPIRED'), {
        status: 400,
      });
    }

    // Verify signature
    const isValid = verifySignature(publicKey, message, signature);
    if (!isValid) {
      return NextResponse.json(apiError('Invalid signature', 'INVALID_SIGNATURE'), {
        status: 401,
      });
    }

    // Create session token
    const { token, expiresAt } = await createSessionToken(publicKey);

    // Set session cookie
    await setSessionCookie(token, expiresAt);

    const response: LoginResponse = {
      token,
      expiresAt,
    };

    return NextResponse.json(apiResponse(response));
  } catch (error) {
    console.error('[API] Login error:', error);
    return NextResponse.json(apiError('Internal server error', 'INTERNAL_ERROR'), {
      status: 500,
    });
  }
}
