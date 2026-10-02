/**
 * Mint more tokens to the faucet wallet
 *
 * Usage: bun run mint:more [amount]
 * Default: 1,000,000 tokens
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  estimateAndSetResourceLimitsFactory,
  estimateResourceLimitsFactory,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getMintToInstruction,
} from '@solana-program/token-2022';
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
const MINT_ADDRESS = process.env.CT_FAUCET_MINT || 'GUg6pt12mec2bMDTY9gCH6dG9FnhHHnEzSKKKt3P8kRw';
const MINT_SECRET_KEY = process.env.MINT_SECRET_KEY;

function toWebSocketUrl(url: string): string {
  return url.replace(/^http/, 'ws');
}

async function main() {
  const amountArg = process.argv[2];
  const amount = amountArg ? parseInt(amountArg, 10) : 1_000_000;

  console.log(`Minting ${amount.toLocaleString()} tokens to faucet...`);

  const mintAddress = address(MINT_ADDRESS);

  // Load faucet keypair to pay for tx
  const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
  if (!faucetPrivateKey) {
    console.error('FAUCET_PRIVATE_KEY not set');
    process.exit(1);
  }
  const faucetSigner = await createKeyPairSignerFromBytes(bs58.decode(faucetPrivateKey));

  const rpc = createSolanaRpc(RPC_URL);

  // Sign with whichever configured key is the mint's CURRENT authority: the
  // faucet key normally, or the mint keypair (MINT_SECRET_KEY, optional) for
  // mints created before authority moved to the faucet.
  const { data: mint } = await fetchMint(rpc, mintAddress);
  if (mint.mintAuthority.__option !== 'Some') {
    console.error(`Mint ${mintAddress} has no mint authority — supply is fixed.`);
    process.exit(1);
  }
  const candidates = [faucetSigner];
  if (MINT_SECRET_KEY) candidates.push(await createKeyPairSignerFromBytes(bs58.decode(MINT_SECRET_KEY)));
  const mintAuthority = candidates.find((signer) => signer.address === mint.mintAuthority.value);
  if (!mintAuthority) {
    console.error(
      `Mint authority is ${mint.mintAuthority.value}, which matches neither FAUCET_PRIVATE_KEY ` +
        `(${faucetSigner.address})${MINT_SECRET_KEY ? ' nor MINT_SECRET_KEY' : ''}.`
    );
    process.exit(1);
  }
  console.log(`Mint authority: ${mintAuthority.address}`);

  const rpcSubscriptions = createSolanaRpcSubscriptions(toWebSocketUrl(RPC_URL));
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  // Get faucet's token account
  const [faucetAta] = await findAssociatedTokenPda({
    owner: faucetSigner.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint: mintAddress,
  });

  const mintAmount = BigInt(amount) * 10n ** BigInt(mint.decimals);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();

  // v1 transactions must carry explicit resource limits: estimate them by simulating.
  const estimateAndSetResourceLimits = estimateAndSetResourceLimitsFactory(estimateResourceLimitsFactory({ rpc }));
  const transactionMessage = pipe(
    createTransactionMessage({ version: 1 }),
    // Faucet is the fee payer; the mint authority signs via the instruction
    (tx) => setTransactionMessageFeePayerSigner(faucetSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [
          getMintToInstruction({
            mint: mintAddress,
            token: faucetAta,
            mintAuthority,
            amount: mintAmount,
          }),
        ],
        tx
      )
  );

  const signedTransaction = await signTransactionMessageWithSigners(
    await estimateAndSetResourceLimits(transactionMessage)
  );
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  await sendAndConfirm(signedTransaction, { commitment: 'confirmed', skipPreflight: true });

  console.log(`Transaction: ${getSignatureFromTransaction(signedTransaction)}`);
  console.log('Done!');
}

main().catch(console.error);
