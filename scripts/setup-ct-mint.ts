/**
 * Setup script to create a CT-enabled mint with tokens for testing
 *
 * Usage: bun run setup:mint (from root)
 *        or: cd apps/web && bun run ../../scripts/setup-ct-mint.ts
 *
 * This will:
 * 1. Create a new Token-2022 mint with ConfidentialTransferMint extension
 * 2. Create a token account for your wallet
 * 3. Mint a large amount of tokens
 * 4. Output the new mint address to update your config
 *
 * Environment variables loaded from apps/web/.env:
 * - FAUCET_PRIVATE_KEY: Your wallet's private key (base58 or JSON array)
 * - NEXT_PUBLIC_SOLANA_RPC_URL: The RPC endpoint
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createMintToInstruction,
  ExtensionType,
  getMintLen,
} from '@solana/spl-token';
import bs58 from 'bs58';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://zk-edge.surfnet.dev:8899';
const MINT_AMOUNT = 1_000_000; // 1 million tokens
const DECIMALS = 9;

// Use getMintLen from spl-token for correct size calculation

/**
 * Builds the InitializeConfidentialTransferMint instruction manually.
 *
 * Instruction layout (Token-2022 Confidential Transfer Extension):
 * - discriminator: u8 (27 = ConfidentialTransferExtension)
 * - sub-discriminator: u8 (0 = InitializeMint)
 * - authority: OptionalNonZeroPubkey (32 bytes, all zeros = None)
 * - auto_approve_new_accounts: PodBool (1 byte)
 * - auditor_elgamal_pubkey: OptionalNonZeroElGamalPubkey (32 bytes, all zeros = None)
 *
 * Total data size: 2 + 32 + 1 + 32 = 67 bytes
 */
function createInitializeConfidentialTransferMintInstruction(
  mint: PublicKey,
  authority: PublicKey | null,
  autoApproveNewAccounts: boolean,
  auditorElGamalPubkey: Uint8Array | null
): TransactionInstruction {
  // Fixed size: 2 (discriminators) + 32 (authority) + 1 (bool) + 32 (auditor) = 67 bytes
  const data = Buffer.alloc(67);
  let offset = 0;

  // [27] = ConfidentialTransferExtension discriminator
  // [0] = InitializeMint sub-instruction
  data[offset++] = 27;
  data[offset++] = 0;

  // Authority: OptionalNonZeroPubkey (32 bytes, all zeros = None)
  if (authority) {
    authority.toBuffer().copy(data, offset);
  }
  // else: already zero-filled
  offset += 32;

  // auto_approve_new_accounts: PodBool (1 byte)
  data[offset++] = autoApproveNewAccounts ? 1 : 0;

  // auditor_elgamal_pubkey: OptionalNonZeroElGamalPubkey (32 bytes, all zeros = None)
  if (auditorElGamalPubkey && auditorElGamalPubkey.length === 32) {
    Buffer.from(auditorElGamalPubkey).copy(data, offset);
  }
  // else: already zero-filled
  offset += 32;

  return new TransactionInstruction({
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    programId: TOKEN_2022_PROGRAM_ID,
    data,
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('CT-Enabled Mint Setup Script');
  console.log('='.repeat(60));
  console.log(`RPC: ${RPC_URL}`);
  console.log();

  // Load the faucet keypair from env
  const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
  if (!faucetPrivateKey) {
    console.error('Error: FAUCET_PRIVATE_KEY not set in environment');
    console.log('Please set it in apps/web/.env');
    process.exit(1);
  }

  let faucetKeypair: Keypair;
  try {
    if (faucetPrivateKey.startsWith('[')) {
      const secretKey = new Uint8Array(JSON.parse(faucetPrivateKey));
      faucetKeypair = Keypair.fromSecretKey(secretKey);
    } else {
      const secretKey = bs58.decode(faucetPrivateKey);
      faucetKeypair = Keypair.fromSecretKey(secretKey);
    }
  } catch (err) {
    console.error('Error parsing FAUCET_PRIVATE_KEY:', err);
    process.exit(1);
  }

  console.log(`Faucet/Authority wallet: ${faucetKeypair.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, 'confirmed');

  // Check SOL balance
  const balance = await connection.getBalance(faucetKeypair.publicKey);
  console.log(`SOL balance: ${balance / 1e9} SOL`);

  if (balance < 0.1 * 1e9) {
    console.warn('Warning: Low SOL balance. You may need more SOL for rent.');
  }

  // Generate a new mint keypair
  const mintKeypair = Keypair.generate();
  console.log(`\nNew Mint Address: ${mintKeypair.publicKey.toBase58()}`);

  // Calculate rent for mint with CT extension using spl-token's getMintLen
  const mintLen = getMintLen([ExtensionType.ConfidentialTransferMint]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  console.log(`Mint account size: ${mintLen} bytes`);
  console.log(`Rent: ${lamports / 1e9} SOL`);

  // Build transaction to create mint
  const tx = new Transaction();

  // 1. Create the mint account
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: faucetKeypair.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );

  // 2. Initialize the Confidential Transfer Mint extension FIRST
  // (Extensions must be initialized before the mint itself)
  tx.add(
    createInitializeConfidentialTransferMintInstruction(
      mintKeypair.publicKey,
      faucetKeypair.publicKey, // authority
      true, // autoApproveNewAccounts
      null  // no auditor
    )
  );

  // 3. Initialize the mint itself
  tx.add(
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      DECIMALS,
      faucetKeypair.publicKey, // mint authority
      faucetKeypair.publicKey, // freeze authority (or null)
      TOKEN_2022_PROGRAM_ID
    )
  );

  console.log('\nCreating mint with CT extension...');

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = faucetKeypair.publicKey;

    // Sign with both the fee payer and the new mint keypair
    tx.sign(faucetKeypair, mintKeypair);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, // Skip for custom RPC
    });

    console.log(`Transaction: ${sig}`);
    console.log('Waiting for confirmation...');

    // Wait a bit for custom RPC
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Mint created successfully!');
  } catch (err) {
    console.error('Error creating mint:', err);
    throw err;
  }

  // 4. Create the faucet's token account
  const faucetAta = await getAssociatedTokenAddress(
    mintKeypair.publicKey,
    faucetKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log(`\nFaucet token account: ${faucetAta.toBase58()}`);

  const createAtaTx = new Transaction();
  createAtaTx.add(
    createAssociatedTokenAccountInstruction(
      faucetKeypair.publicKey, // payer
      faucetAta, // ata
      faucetKeypair.publicKey, // owner
      mintKeypair.publicKey, // mint
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );

  console.log('Creating faucet token account...');

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    createAtaTx.recentBlockhash = blockhash;
    createAtaTx.lastValidBlockHeight = lastValidBlockHeight;
    createAtaTx.feePayer = faucetKeypair.publicKey;
    createAtaTx.sign(faucetKeypair);

    const sig = await connection.sendRawTransaction(createAtaTx.serialize(), {
      skipPreflight: true,
    });

    console.log(`Transaction: ${sig}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('Token account created!');
  } catch (err) {
    console.error('Error creating token account:', err);
    throw err;
  }

  // 5. Mint tokens to the faucet
  const mintAmount = BigInt(MINT_AMOUNT) * BigInt(10 ** DECIMALS);

  const mintToTx = new Transaction();
  mintToTx.add(
    createMintToInstruction(
      mintKeypair.publicKey, // mint
      faucetAta, // destination
      faucetKeypair.publicKey, // authority
      mintAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  console.log(`\nMinting ${MINT_AMOUNT.toLocaleString()} tokens...`);

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    mintToTx.recentBlockhash = blockhash;
    mintToTx.lastValidBlockHeight = lastValidBlockHeight;
    mintToTx.feePayer = faucetKeypair.publicKey;
    mintToTx.sign(faucetKeypair);

    const sig = await connection.sendRawTransaction(mintToTx.serialize(), {
      skipPreflight: true,
    });

    console.log(`Transaction: ${sig}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('Tokens minted!');
  } catch (err) {
    console.error('Error minting tokens:', err);
    throw err;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SETUP COMPLETE!');
  console.log('='.repeat(60));
  console.log(`\nNew CT-Enabled Mint: ${mintKeypair.publicKey.toBase58()}`);
  console.log(`Faucet Token Account: ${faucetAta.toBase58()}`);
  console.log(`Tokens Minted: ${MINT_AMOUNT.toLocaleString()}`);
  console.log(`Decimals: ${DECIMALS}`);
  console.log('\nUpdate your apps/web/.env with:');
  console.log(`CT_FAUCET_MINT=${mintKeypair.publicKey.toBase58()}`);
  console.log('\nOr update TODO.md with the new addresses.');

  // Save mint keypair for future use (if needed to mint more)
  console.log('\n--- SAVE THIS (mint keypair for future minting) ---');
  console.log(`Mint Secret Key: ${bs58.encode(mintKeypair.secretKey)}`);
  console.log('---------------------------------------------------');
}

main().catch(console.error);
