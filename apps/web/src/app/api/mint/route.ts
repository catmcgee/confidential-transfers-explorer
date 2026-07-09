import { NextResponse } from 'next/server';
import { address } from '@solana/kit';
import {
  CT_MINT,
  checkCooldown,
  getServerRpc,
  loadMintAuthoritySigner,
  markRequest,
  mintTokensTo,
} from '@/lib/server/mintTokens';

// User-initiated minting: the requester picks the amount (capped) and the
// server-side mint authority mints straight to their token account.
const MAX_MINT_AMOUNT = 10_000;
const COOLDOWN_MS = 15_000;

export async function POST(request: Request) {
  try {
    const { walletAddress, amount } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    const tokens = Math.floor(Number(amount));
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return NextResponse.json(
        { error: 'Amount must be a positive number of tokens' },
        { status: 400 }
      );
    }
    if (tokens > MAX_MINT_AMOUNT) {
      return NextResponse.json(
        { error: `Amount is capped at ${MAX_MINT_AMOUNT.toLocaleString()} tokens per request` },
        { status: 400 }
      );
    }

    const waitMs = checkCooldown(walletAddress, COOLDOWN_MS);
    if (waitMs > 0) {
      return NextResponse.json(
        { error: `Please wait ${Math.ceil(waitMs / 1000)}s between mints.` },
        { status: 429 }
      );
    }

    const rpc = getServerRpc();
    const authority = await loadMintAuthoritySigner();

    const { signature, tokenAccount, solToppedUp } = await mintTokensTo({
      rpc,
      authority,
      recipient: address(walletAddress),
      tokens,
    });

    markRequest(walletAddress);

    console.log(`[Mint] Minted ${tokens} tokens to ${walletAddress}: ${signature}`);

    return NextResponse.json({
      success: true,
      signature,
      amount: tokens,
      solToppedUp,
      mint: CT_MINT,
      tokenAccount,
    });
  } catch (error) {
    console.error('[Mint] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Mint request failed' },
      { status: 500 }
    );
  }
}
