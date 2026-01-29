import { NextResponse } from 'next/server';
import { apiResponse } from '@ct-explorer/shared';
import { clearSessionCookie } from '@/lib/auth';

export async function POST() {
  await clearSessionCookie();
  return NextResponse.json(apiResponse({ success: true }));
}
