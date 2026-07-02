import { NextResponse } from 'next/server';

// Same-origin JSON-RPC proxy for browser-side Solana calls.
//
// The browser can't use the private keyed RPC directly (the key would be
// exposed), and the public devnet endpoint rate-limits bursty flows like
// multi-transaction confidential transfers — its 429s lack CORS headers,
// surfacing in the browser as opaque "Failed to fetch" errors. Proxying
// through our origin gives the client the private RPC's throughput with no
// CORS in play.
const UPSTREAM_RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  'https://api.devnet.solana.com';

export async function POST(request: Request) {
  try {
    const body = await request.text();
    const upstream = await fetch(UPSTREAM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(25_000),
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: `RPC proxy error: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
      { status: 502 }
    );
  }
}
