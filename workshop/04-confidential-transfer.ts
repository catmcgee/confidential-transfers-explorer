/**
 * STEP 04 — Alice confidentially transfers tokens to Bob.
 *
 * WHAT THIS TEACHES
 *   FIRST, the hook: Bob is brand new and has never configured his token
 *   account for confidential transfers. Alice tries to send to him anyway —
 *   and it fails before a single transaction goes out. Bob has no ElGamal
 *   key on-chain, so there is NOTHING to encrypt the amount to. This is the
 *   app's "recipient has not configured" error. Step 03 already dove into
 *   the fix; here we configure Bob in one line and retry.
 *
 *   THEN, the transfer itself. It needs THREE zero-knowledge proofs:
 *     - EQUALITY proof:  Alice's new (encrypted) balance really equals
 *                        old balance minus the amount — no minting from thin air.
 *     - VALIDITY proof:  the amount ciphertexts are well-formed and encrypt
 *                        the SAME amount to sender, receiver (and auditor).
 *     - RANGE proof:     the amount and remaining balance are non-negative
 *                        (no sending -5 tokens to print 5 for yourself).
 *
 *   Why several transactions? A Solana transaction maxes out at 1232 bytes;
 *   the range proof ALONE is bigger than that. So each proof is verified
 *   up-front into a CONTEXT-STATE ACCOUNT — a tiny scratch account that
 *   records "this proof checked out". The actual Transfer instruction then
 *   just points at the three context accounts. Afterwards they are closed
 *   and their rent refunded to the payer. Scratch space, not state.
 *
 * WHAT TO POINT AT
 *   The failed first attempt — read the error aloud, it is the same
 *   "recipient has not configured" moment as in the app. Then each
 *   transaction printed below is labeled with what its instructions do —
 *   read them aloud. Then open the LAST transfer transaction in the explorer:
 *   no amount anywhere. Compare with a normal transfer where the amount is
 *   right there in the instruction data.
 *
 * RUN (amount in tokens is optional, default 123)
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/04-confidential-transfer.ts [amount]
 */
import { address } from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token-2022';
import {
  getConfidentialTransferInstructionPlan,
  getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import { getTransferSolInstruction } from '@solana-program/system';

import {
  RAW,
  createTools,
  deriveCtKeys,
  decryptAvailable,
  executeInstructions,
  executePlan,
  getCtExtension,
  loadPayer,
  newOwner,
  requireState,
  rpc,
  signerFromPrivateKeyString,
  ui,
  writeState,
} from './helpers.ts';

const SOL_FOR_FEES = 20_000_000n; // 0.02 SOL, so Bob could pay his own fees later

async function main() {
  const amount = RAW(Number(process.argv[2] ?? 123));
  console.log(`STEP 04 — Alice confidentially sends ${ui(amount)} tokens to Bob (devnet)\n`);

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const alice = requireState('alice', '02-deposit-and-apply.ts');
  const payer = await loadPayer();
  const tools = createTools(payer);

  const aliceSigner = await signerFromPrivateKeyString(alice.secretBase58);
  const aliceKeys = await deriveCtKeys(aliceSigner, mint);

  // --- Bob: a brand-new recipient who has NOT configured -------------------
  // He gets a plain token account (like anyone who ever received this token
  // publicly) — but he never opted in to confidential transfers.
  const bob = await newOwner();
  const [bobAta] = await findAssociatedTokenPda({
    mint,
    owner: bob.signer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  console.log(`Bob: ${bob.signer.address} — brand new, has NEVER configured for confidential transfers.`);
  console.log('Giving him some SOL and a plain (unconfigured) token account:');
  await executeInstructions(tools, [
    getTransferSolInstruction({ source: payer, destination: bob.signer.address, amount: SOL_FOR_FEES }),
    getCreateAssociatedTokenIdempotentInstruction({ payer, owner: bob.signer.address, mint, ata: bobAta }),
  ]);

  const sourceToken = await fetchToken(rpc, address(alice.tokenAccount), { commitment: 'confirmed' });
  const before = decryptAvailable(getCtExtension(sourceToken.data), aliceKeys.aesKey);
  console.log(`\nAlice's available balance before: ${ui(before)} tokens`);

  // --- Attempt 1: send to the UNCONFIGURED account. This FAILS. ------------
  // A confidential transfer encrypts the amount to the recipient's ElGamal
  // public key, which lives on the recipient's token account. Bob never
  // published one — so the plan builder cannot even construct the transfer.
  console.log('\nAttempt 1 — Alice tries to send to Bob as-is:');
  let attemptFailed = false;
  try {
    const bobToken = await fetchToken(rpc, bobAta, { commitment: 'confirmed' });
    const doomedPlan = await getConfidentialTransferInstructionPlan({
      sourceToken: address(alice.tokenAccount),
      mint,
      destinationToken: bobAta,
      sourceTokenAccount: sourceToken.data,
      destinationTokenAccount: bobToken.data,
      authority: aliceSigner,
      amount,
      sourceElgamalKeypair: aliceKeys.elgamalKeypair,
      aesKey: aliceKeys.aesKey,
      payer,
      rpc,
    });
    await executePlan(tools, doomedPlan);
  } catch (err) {
    attemptFailed = true;
    console.log('\n  IT FAILS — before any transaction is even built. The error:');
    console.log(`    ${(err as Error).message}`);
    console.log('\n  Bob has no ElGamal key on-chain — there is nothing to encrypt to.');
    console.log('  This is exactly the app\'s "recipient has not configured" error.');
    console.log('  The fix is a one-time account configuration — step 03 was the deep-dive.');
  }
  if (!attemptFailed) throw new Error('Expected the transfer to an unconfigured account to fail, but it succeeded.');

  // --- Fix: configure Bob's account, then retry -----------------------------
  const bobKeys = await deriveCtKeys(bob.signer, mint);
  console.log("\nConfiguring Bob's confidential account (as explained in step 03):");
  await executePlan(
    tools,
    await getCreateConfidentialTransferAccountInstructionPlan({
      payer,
      owner: bob.signer,
      mint,
      rpc,
      elgamalKeypair: bobKeys.elgamalKeypair,
      aesKey: bobKeys.aesKey,
    }),
  );

  const destinationToken = await fetchToken(rpc, bobAta, { commitment: 'confirmed' });
  console.log(`\nBob's ElGamal pubkey (read from HIS account — this is what Alice encrypts to):`);
  console.log(`  ${getCtExtension(destinationToken.data).elgamalPubkey}\n`);

  // --- Attempt 2: the real transfer -----------------------------------------
  // The plan below is built CLIENT-SIDE: Alice's machine encrypts the amount
  // (to her key, Bob's key, and the auditor slot), computes her new balance,
  // and generates all three proofs locally. The chain only VERIFIES.
  console.log('Attempt 2 — building the transfer plan (encrypting + generating 3 ZK proofs locally)...');
  const plan = await getConfidentialTransferInstructionPlan({
    sourceToken: address(alice.tokenAccount),
    mint,
    destinationToken: bobAta,
    sourceTokenAccount: sourceToken.data,
    destinationTokenAccount: destinationToken.data,
    authority: aliceSigner,
    amount,
    sourceElgamalKeypair: aliceKeys.elgamalKeypair,
    aesKey: aliceKeys.aesKey,
    payer,
    rpc,
  });

  console.log('\nExecuting. Watch the transactions — this is why there are several:');
  console.log('  1232-byte tx limit vs proofs that are each hundreds of bytes (the range');
  console.log('  proof alone is ~1.5 KB). Each proof is verified into a context-state');
  console.log('  scratch account first; the transfer references them; then they are');
  console.log('  closed and the rent comes back.');
  await executePlan(tools, plan);

  const afterToken = await fetchToken(rpc, address(alice.tokenAccount), { commitment: 'confirmed' });
  const after = decryptAvailable(getCtExtension(afterToken.data), aliceKeys.aesKey);
  console.log(`\nAlice's available balance after: ${ui(after)} tokens (was ${ui(before)})`);
  console.log(`\nBob has been credited ${ui(amount)} tokens — but ONLY in his encrypted`);
  console.log('PENDING balance, and nothing on-chain says the amount. Not even Bob has');
  console.log('looked yet. Step 03 unpacked the configuration that made this possible;');
  console.log('step 05: Bob decrypts.');

  writeState({
    bob: { name: 'Bob', address: bob.signer.address, secretBase58: bob.secretBase58, tokenAccount: bobAta },
  });
}

main().catch(err => {
  console.error('\nSTEP 04 FAILED:', err);
  process.exit(1);
});
