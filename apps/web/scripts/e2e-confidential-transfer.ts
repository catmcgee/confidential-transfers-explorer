/**
 * End-to-end confidential transfer test against Solana DEVNET.
 *
 * Flow:
 *   1. Load/fund a payer (FAUCET_PRIVATE_KEY in apps/web/.env, or airdrop).
 *   2. Create a Token-2022 mint with the ConfidentialTransferMint extension.
 *   3. Create + configure confidential token accounts for owners A and B.
 *   4. Mint 1000 tokens (public) to A.
 *   5. Deposit 500 into A's confidential pending balance, apply pending.
 *   6. Confidentially transfer 123 tokens A -> B (context-state proof flow).
 *   7. Apply pending on B, decrypt B's available balance, assert == 123.
 *   8. Withdraw 100 from B's confidential balance, assert public balance.
 *
 * MUST run under Node (not Bun) with WASM ESM support:
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/e2e-confidential-transfer.ts
 */
import { readFileSync } from 'node:fs';
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
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  createTransactionPlanner,
  createTransactionPlanExecutor,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  nonDivisibleSequentialInstructionPlan,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  singleInstructionPlan,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  fetchToken,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022';
import {
  deriveAeKeyForOwnerMint,
  deriveElGamalKeypairForOwnerMint,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getConfidentialTransferInstructionPlan,
  getConfidentialWithdrawInstructionPlan,
  getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import { getCreateAccountInstruction } from '@solana-program/system';
// IMPORTANT: import WASM classes from the same entry point the confidential
// helpers use internally ('/bundler'), so objects cross the WASM boundary
// as the same class instances. Node needs --experimental-wasm-modules.
import { AeCiphertext, AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const DECIMALS = 9;
const RAW = (uiAmount: number | bigint) => BigInt(uiAmount) * 10n ** BigInt(DECIMALS);
const MINT_AMOUNT = RAW(1000);
const DEPOSIT_AMOUNT = RAW(500);
const TRANSFER_AMOUNT = RAW(123);
const WITHDRAW_AMOUNT = RAW(100);
const MIN_PAYER_LAMPORTS = 100_000_000n; // ~0.1 SOL
const TX_DELAY_MS = 750; // be gentle with the public devnet RPC

const rpc = createSolanaRpc(RPC_URL);

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;

const passed: string[] = [];
function step(name: string) {
  console.log(`\n=== ${name} ===`);
}
function pass(name: string) {
  passed.push(name);
  console.log(`PASS: ${name}`);
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Payer loading / funding
// ---------------------------------------------------------------------------

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
  throw new Error(`Unsupported private key length: ${bytes.length} (expected 32 or 64 bytes)`);
}

async function getBalance(addr: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(addr).send();
  return BigInt(value);
}

async function requestAirdropWithRetry(addr: Address, sol: number, attempts = 3): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const sig = await rpc.requestAirdrop(addr, lamports(BigInt(sol) * 1_000_000_000n)).send();
      console.log(`Airdrop requested: ${explorerTx(sig)}`);
      await confirmSignature(sig);
      return true;
    } catch (err) {
      console.warn(`Airdrop attempt ${i}/${attempts} failed: ${(err as Error).message}`);
      if (i < attempts) await sleep(3000);
    }
  }
  return false;
}

async function loadPayer(): Promise<KeyPairSigner> {
  const envKey = readEnvVar('FAUCET_PRIVATE_KEY');
  if (envKey) {
    const payer = await signerFromPrivateKeyString(envKey);
    console.log(`Loaded payer from FAUCET_PRIVATE_KEY: ${payer.address}`);
    return payer;
  }
  const payer = await generateKeyPairSigner();
  console.log(`No FAUCET_PRIVATE_KEY found; generated ephemeral payer: ${payer.address}`);
  const ok = await requestAirdropWithRetry(payer.address, 2);
  if (!ok) {
    console.error(
      [
        '',
        'ERROR: Could not fund a payer.',
        'The devnet airdrop failed (likely rate-limited) and no funded key is configured.',
        'Fix one of the following and re-run:',
        '  1. Add FAUCET_PRIVATE_KEY=<base58 or JSON array secret key> to apps/web/.env',
        '     (the account must hold at least ~0.1 devnet SOL), or',
        `  2. Fund this address manually via https://faucet.solana.com and set`,
        `     FAUCET_PRIVATE_KEY accordingly, or`,
        '  3. Wait for the airdrop rate limit to reset and re-run.',
      ].join('\n'),
    );
    process.exit(1);
  }
  return payer;
}

// ---------------------------------------------------------------------------
// Transaction sending / confirmation (HTTP polling, no websockets)
// ---------------------------------------------------------------------------

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
      console.log(`  sent ${explorerTx(signature)}`);
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
  const transactionPlan = await planner(instructionPlan);
  await executor(transactionPlan);
}

async function executeInstructions(
  planner: TransactionPlanner,
  executor: TransactionPlanExecutor,
  instructions: Instruction[],
): Promise<void> {
  for (const instruction of instructions) {
    await executePlan(planner, executor, singleInstructionPlan(instruction));
  }
}

// ---------------------------------------------------------------------------
// Confidential-transfer helpers
// ---------------------------------------------------------------------------

type CtKeys = {
  elgamalKeypair: ElGamalKeypair;
  elgamalSecretKey: ElGamalSecretKey;
  aeKey: AeKey;
};

async function deriveCtKeys(signer: KeyPairSigner, mint: Address): Promise<CtKeys> {
  const derivedElGamal = await deriveElGamalKeypairForOwnerMint({
    signer,
    owner: signer.address,
    mint,
  });
  const derivedAe = await deriveAeKeyForOwnerMint({ signer, owner: signer.address, mint });
  const elgamalSecretKey = ElGamalSecretKey.fromBytes(derivedElGamal.secretKey);
  return {
    elgamalKeypair: ElGamalKeypair.fromSecretKey(elgamalSecretKey),
    elgamalSecretKey,
    aeKey: AeKey.fromBytes(derivedAe),
  };
}

type ConfidentialTransferAccountState = {
  decryptableAvailableBalance: Uint8Array;
  pendingBalanceCreditCounter: bigint;
};

function getConfidentialExtension(tokenData: {
  extensions: { __option: 'Some' | 'None'; value?: readonly { __kind: string }[] };
}): ConfidentialTransferAccountState {
  const extensions = tokenData.extensions.__option === 'Some' ? tokenData.extensions.value! : [];
  const ctExtension = extensions.find(e => e.__kind === 'ConfidentialTransferAccount');
  assert(ctExtension !== undefined, 'token account has a ConfidentialTransferAccount extension');
  return ctExtension as unknown as ConfidentialTransferAccountState;
}

function decryptAvailableBalance(tokenData: Parameters<typeof getConfidentialExtension>[0], aeKey: AeKey): bigint {
  const ctExtension = getConfidentialExtension(tokenData);
  const ciphertext = AeCiphertext.fromBytes(new Uint8Array(ctExtension.decryptableAvailableBalance));
  assert(ciphertext !== undefined, 'decryptable available balance parses as an AeCiphertext');
  return aeKey.decrypt(ciphertext);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Confidential transfer e2e test — devnet`);
  console.log(`RPC: ${RPC_URL}`);

  // --- Step 1: payer -------------------------------------------------------
  step('1. Load payer');
  const payer = await loadPayer();
  let payerBalance = await getBalance(payer.address);
  console.log(`Payer ${payer.address} balance: ${Number(payerBalance) / 1e9} SOL`);
  if (payerBalance < MIN_PAYER_LAMPORTS) {
    console.log('Balance below 0.1 SOL, attempting airdrop...');
    await requestAirdropWithRetry(payer.address, 2);
    payerBalance = await getBalance(payer.address);
  }
  if (payerBalance < MIN_PAYER_LAMPORTS) {
    console.error(
      `ERROR: payer ${payer.address} has ${Number(payerBalance) / 1e9} SOL (< 0.1 SOL needed). ` +
        'Fund it via https://faucet.solana.com and re-run.',
    );
    process.exit(1);
  }
  pass('payer funded');

  const { planner, executor } = createPlannerAndExecutor(payer);

  // --- Step 2: create CT mint ----------------------------------------------
  step('2. Create Token-2022 mint with ConfidentialTransferMint extension');
  const mintSigner = await generateKeyPairSigner();
  const mint = mintSigner.address;
  console.log(`Mint: ${mint}`);
  console.log(`      ${explorerAddress(mint)}`);

  const confidentialTransferMintExtension = extension('ConfidentialTransferMint', {
    authority: payer.address,
    autoApproveNewAccounts: true,
    auditorElgamalPubkey: null,
  });
  const mintSpace = BigInt(getMintSize([confidentialTransferMintExtension]));
  const mintRent = await rpc.getMinimumBalanceForRentExemption(mintSpace).send();

  await executePlan(planner, executor, nonDivisibleSequentialInstructionPlan([
    getCreateAccountInstruction({
      payer,
      newAccount: mintSigner,
      lamports: mintRent,
      space: mintSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeConfidentialTransferMintInstruction({
      mint,
      authority: payer.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    }),
    getInitializeMintInstruction({
      mint,
      decimals: DECIMALS,
      mintAuthority: payer.address,
      freezeAuthority: null,
    }),
  ]));
  pass('mint created with confidential transfer extension');

  // --- Step 3: owners, CT keys and confidential token accounts -------------
  step('3. Create + configure confidential token accounts for A and B');
  const ownerA = payer; // payer doubles as owner A
  const ownerB = await generateKeyPairSigner();
  console.log(`Owner A: ${ownerA.address}`);
  console.log(`Owner B: ${ownerB.address}`);

  const keysA = await deriveCtKeys(ownerA, mint);
  const keysB = await deriveCtKeys(ownerB, mint);

  const [ataA] = await findAssociatedTokenPda({
    mint,
    owner: ownerA.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const [ataB] = await findAssociatedTokenPda({
    mint,
    owner: ownerB.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  console.log(`Token account A: ${ataA}`);
  console.log(`Token account B: ${ataB}`);

  const createAccountPlanA = await getCreateConfidentialTransferAccountInstructionPlan({
    payer,
    owner: ownerA,
    mint,
    rpc,
    elgamalKeypair: keysA.elgamalKeypair,
    aesKey: keysA.aeKey,
  });
  await executePlan(planner, executor, createAccountPlanA);
  console.log('Account A created and configured.');

  const createAccountPlanB = await getCreateConfidentialTransferAccountInstructionPlan({
    payer,
    owner: ownerB,
    mint,
    rpc,
    elgamalKeypair: keysB.elgamalKeypair,
    aesKey: keysB.aeKey,
  });
  await executePlan(planner, executor, createAccountPlanB);
  console.log('Account B created and configured.');
  pass('confidential token accounts created for A and B');

  // --- Step 4: mint public tokens to A --------------------------------------
  step('4. Mint 1000 tokens (public) to A');
  await executeInstructions(planner, executor, [
    getMintToInstruction({
      mint,
      token: ataA,
      mintAuthority: payer,
      amount: MINT_AMOUNT,
    }),
  ]);
  const tokenAAfterMint = await fetchToken(rpc, ataA);
  assert(tokenAAfterMint.data.amount === MINT_AMOUNT, `A public balance == 1000 (got ${tokenAAfterMint.data.amount})`);
  pass('minted 1000 tokens to A');

  // --- Step 5: deposit + apply pending on A ---------------------------------
  step('5. Deposit 500 to A confidential pending balance and apply');
  await executeInstructions(planner, executor, [
    getConfidentialDepositInstruction({
      token: ataA,
      mint,
      authority: ownerA,
      amount: DEPOSIT_AMOUNT,
      decimals: DECIMALS,
    }),
  ]);
  console.log('Deposit confirmed. Applying pending balance...');

  let tokenA = await fetchToken(rpc, ataA);
  await executeInstructions(planner, executor, [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: ataA,
      tokenAccount: tokenA.data,
      authority: ownerA,
      elgamalSecretKey: keysA.elgamalSecretKey,
      aesKey: keysA.aeKey,
    }),
  ]);

  tokenA = await fetchToken(rpc, ataA);
  const availableA = decryptAvailableBalance(tokenA.data, keysA.aeKey);
  assert(availableA === DEPOSIT_AMOUNT, `A available balance == 500 after apply (got ${availableA})`);
  assert(tokenA.data.amount === MINT_AMOUNT - DEPOSIT_AMOUNT, 'A public balance == 500 after deposit');
  pass('deposited 500 and applied pending balance on A');

  // --- Step 6: confidential transfer A -> B ---------------------------------
  step('6. Confidential transfer 123 tokens A -> B (context-state proofs, multiple transactions)');
  const tokenB = await fetchToken(rpc, ataB);
  const transferPlan = await getConfidentialTransferInstructionPlan({
    sourceToken: ataA,
    mint,
    destinationToken: ataB,
    sourceTokenAccount: tokenA.data,
    destinationTokenAccount: tokenB.data,
    authority: ownerA,
    amount: TRANSFER_AMOUNT,
    sourceElgamalKeypair: keysA.elgamalKeypair,
    aesKey: keysA.aeKey,
    payer,
    rpc,
  });
  await executePlan(planner, executor, transferPlan);

  tokenA = await fetchToken(rpc, ataA);
  const availableAAfterTransfer = decryptAvailableBalance(tokenA.data, keysA.aeKey);
  assert(
    availableAAfterTransfer === DEPOSIT_AMOUNT - TRANSFER_AMOUNT,
    `A available balance == 377 after transfer (got ${availableAAfterTransfer})`,
  );
  pass('confidential transfer of 123 tokens A -> B executed');

  // --- Step 7: apply pending on B and verify decrypted balance --------------
  step('7. Apply pending balance on B and decrypt');
  let tokenBAccount = await fetchToken(rpc, ataB);
  await executeInstructions(planner, executor, [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: ataB,
      tokenAccount: tokenBAccount.data,
      authority: ownerB,
      elgamalSecretKey: keysB.elgamalSecretKey,
      aesKey: keysB.aeKey,
    }),
  ]);

  tokenBAccount = await fetchToken(rpc, ataB);
  const availableB = decryptAvailableBalance(tokenBAccount.data, keysB.aeKey);
  console.log(`Decrypted B available balance: ${availableB} raw units`);
  assert(availableB === TRANSFER_AMOUNT, `B available balance == 123 tokens (${TRANSFER_AMOUNT} raw, got ${availableB})`);
  pass('B received exactly 123 tokens confidentially');

  // --- Step 8: withdraw from B ----------------------------------------------
  step('8. Withdraw 100 tokens from B confidential balance');
  const publicBBefore = tokenBAccount.data.amount;
  const withdrawPlan = await getConfidentialWithdrawInstructionPlan({
    token: ataB,
    mint,
    tokenAccount: tokenBAccount.data,
    authority: ownerB,
    amount: WITHDRAW_AMOUNT,
    decimals: DECIMALS,
    elgamalKeypair: keysB.elgamalKeypair,
    aesKey: keysB.aeKey,
    payer,
    rpc,
  });
  await executePlan(planner, executor, withdrawPlan);

  tokenBAccount = await fetchToken(rpc, ataB);
  const publicBAfter = tokenBAccount.data.amount;
  const availableBAfterWithdraw = decryptAvailableBalance(tokenBAccount.data, keysB.aeKey);
  assert(
    publicBAfter - publicBBefore === WITHDRAW_AMOUNT,
    `B public balance increased by 100 tokens (got +${publicBAfter - publicBBefore})`,
  );
  assert(
    availableBAfterWithdraw === TRANSFER_AMOUNT - WITHDRAW_AMOUNT,
    `B available balance == 23 tokens after withdraw (got ${availableBAfterWithdraw})`,
  );
  pass('withdrew 100 tokens from B back to public balance');

  // --- Summary ---------------------------------------------------------------
  console.log('\n========================================');
  console.log('ALL STEPS PASSED');
  console.log('========================================');
  for (const name of passed) console.log(`  [ok] ${name}`);
  console.log(`\nMint: ${mint}`);
  console.log(`  ${explorerAddress(mint)}`);
  console.log(`Token account A: ${ataA}`);
  console.log(`Token account B: ${ataB}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n========================================');
    console.error('E2E TEST FAILED');
    console.error('========================================');
    console.error(err);
    console.error(`\nSteps completed before failure: ${passed.length ? passed.join(', ') : 'none'}`);
    process.exit(1);
  });
