/**
 * STEP 04 — Alice confidentially transfers tokens to Bob.
 *
 * WHAT THIS TEACHES
 *   A confidential transfer needs THREE zero-knowledge proofs:
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
 *   Each transaction printed below is labeled with what its instructions do —
 *   read them aloud. Then open the LAST transfer transaction in the explorer:
 *   no amount anywhere. Compare with a normal transfer where the amount is
 *   right there in the instruction data.
 *
 * RUN (amount in tokens is optional, default 123)
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/04-confidential-transfer.ts [amount]
 */
import { address } from '@solana/kit';
import { fetchToken } from '@solana-program/token-2022';
import { getConfidentialTransferInstructionPlan } from '@solana-program/token-2022/confidential';

import {
  RAW,
  createTools,
  deriveCtKeys,
  decryptAvailable,
  executePlan,
  getCtExtension,
  loadPayer,
  requireState,
  rpc,
  signerFromPrivateKeyString,
  ui,
} from './helpers.ts';

async function main() {
  const amount = RAW(Number(process.argv[2] ?? 123));
  console.log(`STEP 04 — Alice confidentially sends ${ui(amount)} tokens to Bob (devnet)\n`);

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const alice = requireState('alice', '02-configure-account.ts');
  const bob = requireState('bob', '02-configure-account.ts');
  const payer = await loadPayer();
  const tools = createTools(payer);

  const aliceSigner = await signerFromPrivateKeyString(alice.secretBase58);
  const aliceKeys = await deriveCtKeys(aliceSigner, mint);

  const sourceToken = await fetchToken(rpc, address(alice.tokenAccount), { commitment: 'confirmed' });
  const destinationToken = await fetchToken(rpc, address(bob.tokenAccount), { commitment: 'confirmed' });
  const before = decryptAvailable(getCtExtension(sourceToken.data), aliceKeys.aesKey);
  console.log(`Alice's available balance before: ${ui(before)} tokens`);
  console.log(`Bob's ElGamal pubkey (read from HIS account — this is what Alice encrypts to):`);
  console.log(`  ${getCtExtension(destinationToken.data).elgamalPubkey}\n`);

  // The plan below is built CLIENT-SIDE: Alice's machine encrypts the amount
  // (to her key, Bob's key, and the auditor slot), computes her new balance,
  // and generates all three proofs locally. The chain only VERIFIES.
  console.log('Building the transfer plan (encrypting + generating 3 ZK proofs locally)...');
  const plan = await getConfidentialTransferInstructionPlan({
    sourceToken: address(alice.tokenAccount),
    mint,
    destinationToken: address(bob.tokenAccount),
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
  console.log('looked yet. Step 05: Bob decrypts.');
}

main().catch(err => {
  console.error('\nSTEP 04 FAILED:', err);
  process.exit(1);
});
