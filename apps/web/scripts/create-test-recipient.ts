/**
 * Creates a funded, confidential-ready test recipient wallet for the faucet
 * mint (CT_FAUCET_MINT in apps/web/.env):
 *
 *   1. Generates a fresh keypair (secret saved to scripts/test-recipient.json).
 *   2. Funds it with a little SOL from FAUCET_PRIVATE_KEY.
 *   3. Creates + configures a confidential token account, deriving keys with
 *      the SAME human-readable message derivation the web app uses — so
 *      importing the secret into Phantom yields the same keys.
 *   4. Sends it public tokens, deposits + applies half into the confidential
 *      available balance, and verifies by decrypting.
 *
 * Run: NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/create-test-recipient.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionPlanner,
  type TransactionPlanExecutor,
  type InstructionPlan,
  address,
  createSignableMessage,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  createTransactionPlanner,
  createTransactionPlanExecutor,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  singleInstructionPlan,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import {
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import { getTransferSolInstruction } from '@solana-program/system';
import { AeCiphertext, AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const DECIMALS = 9;
const RAW = (uiAmount: number | bigint) => BigInt(uiAmount) * 10n ** BigInt(DECIMALS);
const PUBLIC_TOKENS = RAW(100);
const CONFIDENTIAL_TOKENS = RAW(50);
const SOL_FOR_FEES = 100_000_000n; // 0.1 SOL
const TX_DELAY_MS = 500;

const rpc = createSolanaRpc(RPC_URL);
const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;

function readEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && match[1] === name) {
        return match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // no .env file — fall through
  }
  return undefined;
}

async function signerFromPrivateKeyString(raw: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  if (raw.trim().startsWith('[')) {
    bytes = new Uint8Array(JSON.parse(raw));
  } else {
    bytes = new Uint8Array(getBase58Encoder().encode(raw.trim()));
  }
  if (bytes.length === 64) return await createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`Unsupported private key length: ${bytes.length}`);
}

async function confirmSignature(signature: Signature | string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([signature as Signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return;
      }
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for confirmation of ${signature}`);
}

function createPlannerAndExecutor(payer: KeyPairSigner): {
  planner: TransactionPlanner;
  executor: TransactionPlanExecutor;
} {
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(
        createTransactionMessage({ version: 0 }),
        message => setTransactionMessageFeePayerSigner(payer, message),
      ),
  });
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_context, transactionMessage) => {
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const withLifetime = setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, transactionMessage);
      const transaction = await signTransactionMessageWithSigners(withLifetime);
      const signature = getSignatureFromTransaction(transaction);
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64' })
        .send();
      console.log(`  sent https://explorer.solana.com/tx/${signature}?cluster=devnet`);
      await confirmSignature(signature);
      await sleep(TX_DELAY_MS);
      return transaction;
    },
  });
  return { planner, executor };
}

async function executePlan(
  planner: TransactionPlanner,
  executor: TransactionPlanExecutor,
  instructionPlan: InstructionPlan,
): Promise<void> {
  await executor(await planner(instructionPlan));
}

async function executeInstruction(
  planner: TransactionPlanner,
  executor: TransactionPlanExecutor,
  instruction: Instruction,
): Promise<void> {
  await executePlan(planner, executor, singleInstructionPlan(instruction));
}

// Text-message key derivation — MUST match apps/web/src/lib/confidentialTransfer.ts
// deriveCtKeys, so the web app (Phantom signing the same text) derives the
// same keys for this wallet.
async function deriveCtKeysFromText(signer: KeyPairSigner, mint: Address) {
  const signText = async (text: string): Promise<Uint8Array> => {
    const [dictionary] = await signer.signMessages([
      createSignableMessage(new TextEncoder().encode(text)),
    ]);
    const signature = dictionary?.[signer.address];
    if (!signature) throw new Error('No signature produced');
    return new Uint8Array(signature);
  };

  const elgamalSignature = await signText(`ElGamalSecretKey:${signer.address}:${mint}`);
  const elgamalKeypair = ElGamalKeypair.fromSignature(elgamalSignature);
  const aeSignature = await signText(`AeKey:${signer.address}:${mint}`);
  const aesKey = AeKey.fromSignature(aeSignature);
  return { elgamalKeypair, elgamalSecretKey: elgamalKeypair.secret(), aesKey };
}

async function main() {
  const faucetKey = readEnvVar('FAUCET_PRIVATE_KEY');
  const mintAddress = readEnvVar('CT_FAUCET_MINT');
  if (!faucetKey || !mintAddress) {
    throw new Error('FAUCET_PRIVATE_KEY and CT_FAUCET_MINT must be set in apps/web/.env');
  }
  const payer = await signerFromPrivateKeyString(faucetKey);
  const mint = address(mintAddress);
  console.log(`Payer: ${payer.address}`);
  console.log(`Mint:  ${mint}`);

  // 1. Fresh recipient keypair with an exportable secret
  const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const recipient = await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes);
  console.log(`\nRecipient wallet: ${recipient.address}`);

  const { planner, executor } = createPlannerAndExecutor(payer);

  // 2. Fund with SOL for future fees
  console.log('\nFunding recipient with 0.1 SOL...');
  await executeInstruction(
    planner,
    executor,
    getTransferSolInstruction({
      source: payer,
      destination: recipient.address,
      amount: SOL_FOR_FEES,
    }),
  );

  // 3. Create + configure the confidential token account
  console.log('Deriving CT keys (web-app-compatible text derivation)...');
  const keys = await deriveCtKeysFromText(recipient, mint);

  console.log('Creating + configuring confidential token account...');
  const configurePlan = await getCreateConfidentialTransferAccountInstructionPlan({
    payer,
    owner: recipient,
    mint,
    rpc,
    elgamalKeypair: keys.elgamalKeypair,
    aesKey: keys.aesKey,
  });
  await executePlan(planner, executor, configurePlan);

  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipient.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });
  const [payerAta] = await findAssociatedTokenPda({
    owner: payer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });

  // 4. Send public tokens from the faucet stash
  console.log(`Sending ${PUBLIC_TOKENS / RAW(1)} public tokens...`);
  await executeInstruction(
    planner,
    executor,
    getTransferCheckedInstruction({
      source: payerAta,
      mint,
      destination: recipientAta,
      authority: payer,
      amount: PUBLIC_TOKENS,
      decimals: DECIMALS,
    }),
  );

  // 5. Deposit + apply half into the confidential balance
  console.log(`Depositing ${CONFIDENTIAL_TOKENS / RAW(1)} into confidential pending...`);
  await executeInstruction(
    planner,
    executor,
    getConfidentialDepositInstruction({
      token: recipientAta,
      mint,
      authority: recipient,
      amount: CONFIDENTIAL_TOKENS,
      decimals: DECIMALS,
    }),
  );

  console.log('Applying pending balance...');
  const tokenAccount = await fetchToken(rpc, recipientAta, { commitment: 'confirmed' });
  await executeInstruction(
    planner,
    executor,
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: recipientAta,
      tokenAccount: tokenAccount.data,
      authority: recipient,
      elgamalSecretKey: keys.elgamalSecretKey,
      aesKey: keys.aesKey,
    }),
  );

  // 6. Verify by decrypting the available balance
  const finalAccount = await fetchToken(rpc, recipientAta, { commitment: 'confirmed' });
  const extensions =
    finalAccount.data.extensions.__option === 'Some' ? finalAccount.data.extensions.value : [];
  const ctExtension = extensions.find(e => e.__kind === 'ConfidentialTransferAccount') as
    | { decryptableAvailableBalance: Uint8Array }
    | undefined;
  if (!ctExtension) throw new Error('CT extension missing after configure');
  const ciphertext = AeCiphertext.fromBytes(new Uint8Array(ctExtension.decryptableAvailableBalance));
  if (!ciphertext) throw new Error('Could not parse decryptable balance');
  const available = keys.aesKey.decrypt(ciphertext);
  console.log(`Decrypted confidential available balance: ${available} raw (${available / RAW(1)} tokens)`);
  if (available !== CONFIDENTIAL_TOKENS) {
    throw new Error(`Expected ${CONFIDENTIAL_TOKENS}, got ${available}`);
  }

  // 7. Save the secret so the wallet can be imported/inspected later
  const secretBase58 = getBase58Decoder().decode(privateKeyBytes);
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), 'test-recipient.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        address: recipient.address,
        tokenAccount: recipientAta,
        mint,
        privateKeyBase58: secretBase58,
        note: 'Devnet test wallet. Private key (32-byte seed) in base58.',
      },
      null,
      2,
    ),
  );

  console.log('\n============================================');
  console.log('TEST RECIPIENT READY');
  console.log('============================================');
  console.log(`Wallet address:       ${recipient.address}`);
  console.log(`Token account:        ${recipientAta}`);
  console.log(`Public tokens:        ${PUBLIC_TOKENS / RAW(1)}`);
  console.log(`Confidential balance: ${CONFIDENTIAL_TOKENS / RAW(1)}`);
  console.log(`Secret saved to:      ${outPath}`);
  console.log(`Explorer:             ${explorerAddress(recipient.address)}`);
  console.log('\nPaste the WALLET ADDRESS into the Send form as the recipient.');
}

main().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
