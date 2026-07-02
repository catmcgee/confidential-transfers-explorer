/**
 * Setup script to create a CT-enabled mint with tokens for testing
 *
 * Usage: bun run setup:mint (from root)
 *        or: bun run scripts/setup-ct-mint.ts
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';
import bs58 from 'bs58';

// Load env vars from apps/web/.env (without overriding already-set ones)
function loadEnvFile(): void {
  try {
    const envPath = fileURLToPath(new URL('../apps/web/.env', import.meta.url));
    const contents = readFileSync(envPath, 'utf8');
    for (const line of contents.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file found; rely on the environment
  }
}

loadEnvFile();

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const MINT_AMOUNT = 1_000_000; // 1 million tokens
const DECIMALS = 9;

function toWebSocketUrl(url: string): string {
  return url.replace(/^http/, 'ws');
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

  let faucetSigner: KeyPairSigner;
  try {
    let secretKey: Uint8Array;
    if (faucetPrivateKey.startsWith('[')) {
      secretKey = new Uint8Array(JSON.parse(faucetPrivateKey));
    } else {
      secretKey = bs58.decode(faucetPrivateKey);
    }
    faucetSigner = await createKeyPairSignerFromBytes(secretKey);
  } catch (err) {
    console.error('Error parsing FAUCET_PRIVATE_KEY:', err);
    process.exit(1);
  }

  console.log(`Faucet/Authority wallet: ${faucetSigner.address}`);

  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(toWebSocketUrl(RPC_URL));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  async function sendInstructions(instructions: Instruction[]): Promise<string> {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(faucetSigner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx)
    );
    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    assertIsTransactionWithBlockhashLifetime(signedTransaction);
    await sendAndConfirm(signedTransaction, { commitment: 'confirmed', skipPreflight: true });
    return getSignatureFromTransaction(signedTransaction);
  }

  // Check SOL balance
  const { value: balance } = await rpc.getBalance(faucetSigner.address).send();
  console.log(`SOL balance: ${Number(balance) / 1e9} SOL`);

  if (balance < BigInt(0.1 * 1e9)) {
    console.warn('Warning: Low SOL balance. You may need more SOL for rent.');
  }

  // Generate a new mint keypair (from extractable private key bytes so we can print it)
  const mintPrivateKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const mintSigner = await createKeyPairSignerFromPrivateKeyBytes(mintPrivateKeyBytes);
  console.log(`\nNew Mint Address: ${mintSigner.address}`);

  // Calculate rent for a mint with the ConfidentialTransferMint extension
  const mintSpace = getMintSize([
    extension('ConfidentialTransferMint', {
      authority: faucetSigner.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    }),
  ]);
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(mintSpace)).send();

  console.log(`Mint account size: ${mintSpace} bytes`);
  console.log(`Rent: ${Number(rent) / 1e9} SOL`);

  console.log('\nCreating mint with CT extension...');

  try {
    const sig = await sendInstructions([
      // 1. Create the mint account
      getCreateAccountInstruction({
        payer: faucetSigner,
        newAccount: mintSigner,
        space: BigInt(mintSpace),
        lamports: rent,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      // 2. Initialize the Confidential Transfer Mint extension FIRST
      // (Extensions must be initialized before the mint itself)
      getInitializeConfidentialTransferMintInstruction({
        mint: mintSigner.address,
        authority: faucetSigner.address,
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: null, // no auditor
      }),
      // 3. Initialize the mint itself
      getInitializeMintInstruction({
        mint: mintSigner.address,
        decimals: DECIMALS,
        mintAuthority: faucetSigner.address,
        freezeAuthority: faucetSigner.address,
      }),
    ]);

    console.log(`Transaction: ${sig}`);
    console.log('Mint created successfully!');
  } catch (err) {
    console.error('Error creating mint:', err);
    throw err;
  }

  // 4. Create the faucet's token account
  const [faucetAta] = await findAssociatedTokenPda({
    owner: faucetSigner.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint: mintSigner.address,
  });

  console.log(`\nFaucet token account: ${faucetAta}`);
  console.log('Creating faucet token account...');

  try {
    const sig = await sendInstructions([
      getCreateAssociatedTokenInstruction({
        payer: faucetSigner,
        ata: faucetAta,
        owner: faucetSigner.address,
        mint: mintSigner.address,
      }),
    ]);

    console.log(`Transaction: ${sig}`);
    console.log('Token account created!');
  } catch (err) {
    console.error('Error creating token account:', err);
    throw err;
  }

  // 5. Mint tokens to the faucet
  const mintAmount = BigInt(MINT_AMOUNT) * BigInt(10 ** DECIMALS);

  console.log(`\nMinting ${MINT_AMOUNT.toLocaleString()} tokens...`);

  try {
    const sig = await sendInstructions([
      getMintToInstruction({
        mint: mintSigner.address,
        token: faucetAta,
        mintAuthority: faucetSigner,
        amount: mintAmount,
      }),
    ]);

    console.log(`Transaction: ${sig}`);
    console.log('Tokens minted!');
  } catch (err) {
    console.error('Error minting tokens:', err);
    throw err;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SETUP COMPLETE!');
  console.log('='.repeat(60));
  console.log(`\nNew CT-Enabled Mint: ${mintSigner.address}`);
  console.log(`Faucet Token Account: ${faucetAta}`);
  console.log(`Tokens Minted: ${MINT_AMOUNT.toLocaleString()}`);
  console.log(`Decimals: ${DECIMALS}`);
  console.log('\nUpdate your apps/web/.env with:');
  console.log(`CT_FAUCET_MINT=${mintSigner.address}`);
  console.log('\nOr update TODO.md with the new addresses.');

  // Save mint keypair for future use (if needed to mint more)
  // 64-byte secret key = 32-byte private key seed + 32-byte public key
  const mintSecretKey = new Uint8Array(64);
  mintSecretKey.set(mintPrivateKeyBytes, 0);
  mintSecretKey.set(getAddressEncoder().encode(mintSigner.address), 32);
  console.log('\n--- SAVE THIS (mint keypair for future minting) ---');
  console.log(`Mint Secret Key: ${bs58.encode(mintSecretKey)}`);
  console.log('---------------------------------------------------');
}

main().catch(console.error);
