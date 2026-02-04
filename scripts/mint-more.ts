/**
 * Mint more tokens to the faucet wallet
 *
 * Usage: bun run mint:more [amount]
 * Default: 1,000,000 tokens
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createMintToInstruction, getAssociatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://zk-edge.surfnet.dev:8899';
const MINT_ADDRESS = process.env.CT_FAUCET_MINT || 'GUg6pt12mec2bMDTY9gCH6dG9FnhHHnEzSKKKt3P8kRw';
const MINT_SECRET_KEY = process.env.MINT_SECRET_KEY;
const DECIMALS = 9;

async function main() {
  const amountArg = process.argv[2];
  const amount = amountArg ? parseInt(amountArg, 10) : 1_000_000;

  console.log(`Minting ${amount.toLocaleString()} tokens to faucet...`);

  // Load mint keypair (has mint authority)
  if (!MINT_SECRET_KEY) {
    console.error('MINT_SECRET_KEY not set in .env');
    process.exit(1);
  }
  const mintKeypair = Keypair.fromSecretKey(bs58.decode(MINT_SECRET_KEY));
  const mintPubkey = new PublicKey(MINT_ADDRESS);

  // Load faucet keypair to pay for tx
  const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
  if (!faucetPrivateKey) {
    console.error('FAUCET_PRIVATE_KEY not set');
    process.exit(1);
  }
  const faucetKeypair = Keypair.fromSecretKey(bs58.decode(faucetPrivateKey));

  const connection = new Connection(RPC_URL, 'confirmed');

  // Get faucet's token account
  const faucetAta = await getAssociatedTokenAddress(
    mintPubkey,
    faucetKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const mintAmount = BigInt(amount) * BigInt(10 ** DECIMALS);

  const tx = new Transaction();
  tx.add(
    createMintToInstruction(
      mintPubkey,
      faucetAta,
      mintKeypair.publicKey, // mint authority
      mintAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = faucetKeypair.publicKey;

  // Sign with both faucet (fee payer) and mint keypair (authority)
  tx.sign(faucetKeypair, mintKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log(`Transaction: ${sig}`);
  console.log('Done!');
}

main().catch(console.error);
