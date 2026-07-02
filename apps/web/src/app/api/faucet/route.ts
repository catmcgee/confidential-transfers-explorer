import { NextResponse } from 'next/server';
import type { Instruction, KeyPairSigner } from '@solana/kit';

// Confidential transfer enabled mint address (configure this)
const CT_MINT = process.env.CT_FAUCET_MINT || '9bLcAhVjiUZsTdpcg2HtrddiSzuK5uEezAWDi7u1aght';
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const FAUCET_AMOUNT = 50; // Amount to send (in token units before decimals)
const SOL_AMOUNT = 0.1; // Amount of SOL to send for transaction fees

// Track wallets that have already received tokens (one per wallet, ever)
const walletsClaimed: Set<string> = new Set();

export async function POST(request: Request) {
  try {
    const { walletAddress } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    // Check if wallet already claimed
    if (walletsClaimed.has(walletAddress)) {
      return NextResponse.json(
        { error: 'This wallet has already received tokens from the faucet.' },
        { status: 429 }
      );
    }

    // Import Solana dependencies
    const {
      address,
      appendTransactionMessageInstructions,
      createKeyPairSignerFromBytes,
      createSolanaRpc,
      createTransactionMessage,
      getBase64EncodedWireTransaction,
      getSignatureFromTransaction,
      pipe,
      setTransactionMessageFeePayerSigner,
      setTransactionMessageLifetimeUsingBlockhash,
      signTransactionMessageWithSigners,
    } = await import('@solana/kit');

    const rpc = createSolanaRpc(RPC_URL);
    const recipientAddress = address(walletAddress);

    // Check if faucet keypair is configured
    const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
    if (!faucetPrivateKey) {
      return NextResponse.json(
        { error: 'Faucet not configured. Please contact the administrator.' },
        { status: 503 }
      );
    }

    // Token-2022 and System program clients
    const {
      TOKEN_2022_PROGRAM_ADDRESS,
      fetchMint,
      findAssociatedTokenPda,
      getCreateAssociatedTokenIdempotentInstruction,
      getTransferCheckedInstruction,
    } = await import('@solana-program/token-2022');
    const { getTransferSolInstruction } = await import('@solana-program/system');

    // Parse faucet keypair from base58 or JSON array
    let faucetSigner: KeyPairSigner;
    try {
      let secretKey: Uint8Array;
      if (faucetPrivateKey.startsWith('[')) {
        // JSON array format
        secretKey = new Uint8Array(JSON.parse(faucetPrivateKey));
      } else {
        // Base58 format
        const bs58 = await import('bs58');
        secretKey = bs58.default.decode(faucetPrivateKey);
      }
      faucetSigner = await createKeyPairSignerFromBytes(secretKey);
    } catch {
      console.error('Invalid faucet private key format');
      return NextResponse.json(
        { error: 'Faucet configuration error' },
        { status: 500 }
      );
    }

    const mintAddress = address(CT_MINT);

    // Get the faucet's token account
    const [faucetAta] = await findAssociatedTokenPda({
      owner: faucetSigner.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mintAddress,
    });

    // Get the recipient's token account (created idempotently below if needed)
    const [recipientAta] = await findAssociatedTokenPda({
      owner: recipientAddress,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mintAddress,
    });

    // Build the instruction list
    const instructions: Instruction[] = [];

    // Check recipient SOL balance and add SOL transfer if needed
    const { value: recipientBalance } = await rpc.getBalance(recipientAddress).send();
    const solLamports = Math.floor(SOL_AMOUNT * 1_000_000_000);

    if (recipientBalance < BigInt(solLamports)) {
      // Send SOL for transaction fees
      instructions.push(
        getTransferSolInstruction({
          source: faucetSigner,
          destination: recipientAddress,
          amount: BigInt(solLamports),
        })
      );
      console.log(`[Faucet] Adding ${SOL_AMOUNT} SOL transfer to ${walletAddress}`);
    }

    // Create the recipient ATA if needed (idempotent: no-op when it already exists)
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: faucetSigner,
        ata: recipientAta,
        owner: recipientAddress,
        mint: mintAddress,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      })
    );

    // Get mint info for decimals
    let decimals = 9;
    try {
      const mintAccount = await fetchMint(rpc, mintAddress);
      decimals = mintAccount.data.decimals;
    } catch {
      // Fall back to 9 decimals if the mint cannot be fetched/decoded
    }
    const amount = BigInt(FAUCET_AMOUNT) * BigInt(10 ** decimals);

    // Add transfer instruction
    instructions.push(
      getTransferCheckedInstruction({
        source: faucetAta,
        mint: mintAddress,
        destination: recipientAta,
        authority: faucetSigner,
        amount,
        decimals,
      })
    );

    // Get recent blockhash, sign and send
    const { value: latestBlockhash } = await rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send();

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(faucetSigner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signedTransaction), {
        encoding: 'base64',
        skipPreflight: true,
      })
      .send();
    const signature = getSignatureFromTransaction(signedTransaction);

    // Mark wallet as claimed
    walletsClaimed.add(walletAddress);

    console.log(`[Faucet] Sent ${FAUCET_AMOUNT} tokens + ${SOL_AMOUNT} SOL to ${walletAddress}: ${signature}`);

    return NextResponse.json({
      success: true,
      signature,
      amount: FAUCET_AMOUNT,
      solAmount: SOL_AMOUNT,
      mint: CT_MINT,
      tokenAccount: recipientAta,
    });
  } catch (error) {
    console.error('[Faucet] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Faucet request failed' },
      { status: 500 }
    );
  }
}
