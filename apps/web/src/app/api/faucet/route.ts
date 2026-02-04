import { NextResponse } from 'next/server';

// Confidential transfer enabled mint address (configure this)
const CT_MINT = process.env.CT_FAUCET_MINT || '9bLcAhVjiUZsTdpcg2HtrddiSzuK5uEezAWDi7u1aght';
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://zk-edge.surfnet.dev:8899';
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
    const { Keypair, Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    const connection = new Connection(RPC_URL, 'confirmed');
    const recipientPubkey = new PublicKey(walletAddress);

    // Check if faucet keypair is configured
    const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
    if (!faucetPrivateKey) {
      return NextResponse.json(
        { error: 'Faucet not configured. Please contact the administrator.' },
        { status: 503 }
      );
    }

    // Solana dependencies already imported above
    const {
      getAssociatedTokenAddress,
      createAssociatedTokenAccountInstruction,
      createTransferInstruction,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    } = await import('@solana/spl-token');

    // Parse faucet keypair from base58 or JSON array
    let faucetKeypair: InstanceType<typeof Keypair>;
    try {
      if (faucetPrivateKey.startsWith('[')) {
        // JSON array format
        const secretKey = new Uint8Array(JSON.parse(faucetPrivateKey));
        faucetKeypair = Keypair.fromSecretKey(secretKey);
      } else {
        // Base58 format
        const bs58 = await import('bs58');
        const secretKey = bs58.default.decode(faucetPrivateKey);
        faucetKeypair = Keypair.fromSecretKey(secretKey);
      }
    } catch {
      console.error('Invalid faucet private key format');
      return NextResponse.json(
        { error: 'Faucet configuration error' },
        { status: 500 }
      );
    }

    // connection and recipientPubkey already created above
    const mintPubkey = new PublicKey(CT_MINT);

    // Get the faucet's token account
    const faucetAta = await getAssociatedTokenAddress(
      mintPubkey,
      faucetKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Get the recipient's token account (create if needed)
    const recipientAta = await getAssociatedTokenAddress(
      mintPubkey,
      recipientPubkey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Check if recipient ATA exists
    const recipientAtaInfo = await connection.getAccountInfo(recipientAta);

    // Build transaction
    const transaction = new Transaction();

    // Check recipient SOL balance and add SOL transfer if needed
    const recipientBalance = await connection.getBalance(recipientPubkey);
    const solLamports = Math.floor(SOL_AMOUNT * LAMPORTS_PER_SOL);

    if (recipientBalance < solLamports) {
      // Send SOL for transaction fees
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: faucetKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: solLamports,
        })
      );
      console.log(`[Faucet] Adding ${SOL_AMOUNT} SOL transfer to ${walletAddress}`);
    }

    // Add create ATA instruction if needed
    if (!recipientAtaInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          faucetKeypair.publicKey, // payer
          recipientAta, // ata
          recipientPubkey, // owner
          mintPubkey, // mint
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // Get mint info for decimals
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const decimals = (mintInfo.value?.data as { parsed: { info: { decimals: number } } })?.parsed?.info?.decimals || 9;
    const amount = BigInt(FAUCET_AMOUNT) * BigInt(10 ** decimals);

    // Add transfer instruction
    transaction.add(
      createTransferInstruction(
        faucetAta,
        recipientAta,
        faucetKeypair.publicKey,
        amount,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    // Get recent blockhash and send
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = faucetKeypair.publicKey;

    // Sign and send
    transaction.sign(faucetKeypair);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true, // Skip for custom RPC
    });

    // Mark wallet as claimed
    walletsClaimed.add(walletAddress);

    console.log(`[Faucet] Sent ${FAUCET_AMOUNT} tokens + ${SOL_AMOUNT} SOL to ${walletAddress}: ${signature}`);

    return NextResponse.json({
      success: true,
      signature,
      amount: FAUCET_AMOUNT,
      solAmount: SOL_AMOUNT,
      mint: CT_MINT,
      tokenAccount: recipientAta.toBase58(),
    });
  } catch (error) {
    console.error('[Faucet] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Faucet request failed' },
      { status: 500 }
    );
  }
}
