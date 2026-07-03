/**
 * STEP 02 — Mint public tokens to Alice, deposit into her confidential
 *           balance, and apply the pending balance.
 *
 * WHAT THIS TEACHES
 *   A confidential token account has THREE balances:
 *     - PUBLIC:    the normal Token-2022 amount, visible to everyone.
 *     - PENDING:   encrypted; where incoming credits (deposits, transfers)
 *                  land. Others can ADD to it homomorphically.
 *     - AVAILABLE: encrypted; the balance you can actually spend.
 *
 *   Why does PENDING exist at all? Because only the OWNER can re-encrypt
 *   their own running balance: spending requires proving things about your
 *   balance ciphertext, so the ciphertext must not change under your feet
 *   while someone else credits you. Incoming funds therefore accumulate in
 *   pending, and the owner periodically runs ApplyPendingBalance to fold
 *   them into available — decrypting the pending amount locally and writing
 *   a fresh AES-encrypted "decryptable available balance" only they can read.
 *
 *   (The script quietly sets up Alice's confidential token account first —
 *   an account must be configured with an encryption key before it can hold
 *   encrypted balances. How that works is step 04's deep-dive.)
 *
 * WHAT TO POINT AT
 *   The three balance lines printed after each stage: watch value move
 *   public -> pending -> available. On the explorer, the deposit amount is
 *   still visible (deposits are public!) — confidentiality starts AFTER
 *   tokens are inside the encrypted balances.
 *
 * RUN
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/02-deposit-and-apply.ts
 */
import { address } from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
  getMintToInstruction,
} from '@solana-program/token-2022';
import {
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import { getTransferSolInstruction } from '@solana-program/system';

import {
  type CtKeys,
  DECIMALS,
  RAW,
  createTools,
  deriveCtKeys,
  decryptAvailable,
  decryptPending,
  executeInstructions,
  executePlan,
  getCtExtension,
  loadPayer,
  newOwner,
  requireState,
  rpc,
  ui,
  writeState,
} from './helpers.ts';

const SOL_FOR_FEES = 20_000_000n; // 0.02 SOL, so Alice could pay her own fees later
const MINT_AMOUNT = RAW(1000);
const DEPOSIT_AMOUNT = RAW(500);

async function printBalances(tokenAccount: string, keys: CtKeys, label: string) {
  const token = await fetchToken(rpc, address(tokenAccount), { commitment: 'confirmed' });
  const ct = getCtExtension(token.data);
  console.log(`\n  Alice's three balances ${label}:`);
  console.log(`    public:    ${ui(token.data.amount)} tokens (anyone can read this)`);
  console.log(`    pending:   ${ui(decryptPending(ct, keys.elgamalSecretKey))} tokens (decrypted with her ElGamal key)`);
  console.log(`    available: ${ui(decryptAvailable(ct, keys.aesKey))} tokens (decrypted with her AES key)`);
}

async function main() {
  console.log('STEP 02 — deposit into the confidential balance and apply pending (devnet)\n');

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const payer = await loadPayer();
  const tools = createTools(payer);
  console.log(`Mint: ${mint}\n`);

  // --- 0. Setup: a fresh wallet for Alice, funded and configured -----------
  // A token account must be configured with an encryption key before it can
  // hold encrypted balances — we do that quietly here and unpack it in 04.
  // Alice's 32-byte seed goes into state.json so later steps can sign as her.
  const alice = await newOwner();
  console.log(`Alice: ${alice.signer.address}`);
  console.log("Setting up Alice's confidential account (how configuration works is step 04):");
  await executeInstructions(tools, [
    getTransferSolInstruction({ source: payer, destination: alice.signer.address, amount: SOL_FOR_FEES }),
  ]);
  const keys = await deriveCtKeys(alice.signer, mint);
  await executePlan(
    tools,
    await getCreateConfidentialTransferAccountInstructionPlan({
      payer,
      owner: alice.signer,
      mint,
      rpc,
      elgamalKeypair: keys.elgamalKeypair,
      aesKey: keys.aesKey,
    }),
  );
  const [aliceAta] = await findAssociatedTokenPda({
    mint,
    owner: alice.signer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });

  // --- 1. Mint PUBLIC tokens to Alice (plain Token-2022, fully visible) ----
  console.log(`\nMinting ${ui(MINT_AMOUNT)} public tokens to Alice:`);
  await executeInstructions(tools, [
    getMintToInstruction({ mint, token: aliceAta, mintAuthority: payer, amount: MINT_AMOUNT }),
  ]);
  await printBalances(aliceAta, keys, 'after mint');

  // --- 2. Deposit: public -> encrypted PENDING ------------------------------
  // The amount here is a PUBLIC instruction argument — anyone can see 500
  // entered the confidential system. Privacy begins once it's inside.
  console.log(`\nDepositing ${ui(DEPOSIT_AMOUNT)} into Alice's confidential PENDING balance:`);
  await executeInstructions(tools, [
    getConfidentialDepositInstruction({
      token: aliceAta,
      mint,
      authority: alice.signer,
      amount: DEPOSIT_AMOUNT,
      decimals: DECIMALS,
    }),
  ]);
  await printBalances(aliceAta, keys, 'after deposit');

  // --- 3. Apply: PENDING -> AVAILABLE ---------------------------------------
  // Only Alice can do this: she decrypts her pending credits locally and
  // re-encrypts her new available balance under her own AES key.
  console.log('\nApplying the pending balance (Alice folds credits into her spendable balance):');
  const token = await fetchToken(rpc, aliceAta, { commitment: 'confirmed' });
  await executeInstructions(tools, [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: aliceAta,
      tokenAccount: token.data,
      authority: alice.signer,
      elgamalSecretKey: keys.elgamalSecretKey,
      aesKey: keys.aesKey,
    }),
  ]);
  await printBalances(aliceAta, keys, 'after apply');

  console.log(`\nDone. Alice now has ${ui(DEPOSIT_AMOUNT)} SPENDABLE confidential tokens,`);
  console.log('and the remainder is still public. Step 03 sends some of it to Bob — secretly.');

  writeState({
    alice: { name: 'Alice', address: alice.signer.address, secretBase58: alice.secretBase58, tokenAccount: aliceAta },
  });
}

main().catch(err => {
  console.error('\nSTEP 02 FAILED:', err);
  process.exit(1);
});
