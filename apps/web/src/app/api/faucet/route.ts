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

// Starter amount minted to first-time visitors (whole tokens)
const FAUCET_AMOUNT = 50;
// Per-wallet cooldown so the faucet can't be spammed.
const COOLDOWN_MS = 60_000;

export async function POST(request: Request) {
  try {
    const { walletAddress } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    const waitMs = checkCooldown(walletAddress, COOLDOWN_MS);
    if (waitMs > 0) {
      return NextResponse.json(
        { error: `Faucet cooldown: try again in ${Math.ceil(waitMs / 1000)}s.` },
        { status: 429 }
      );
    }

    const rpc = getServerRpc();
    const authority = await loadMintAuthoritySigner();

    const { signature, tokenAccount, solToppedUp } = await mintTokensTo({
      rpc,
      authority,
      recipient: address(walletAddress),
      tokens: FAUCET_AMOUNT,
    });

    markRequest(walletAddress);

    console.log(
      `[Faucet] Minted ${FAUCET_AMOUNT} tokens${solToppedUp ? ' + SOL top-up' : ''} to ${walletAddress}: ${signature}`
    );

    return NextResponse.json({
      success: true,
      signature,
      amount: FAUCET_AMOUNT,
      solToppedUp,
      mint: CT_MINT,
      tokenAccount,
    });
  } catch (error) {
    console.error('[Faucet] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Faucet request failed' },
      { status: 500 }
    );
  }
}
