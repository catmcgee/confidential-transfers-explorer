/**
 * STEP 02 — Create Alice and Bob, derive their encryption keys, and configure
 *           confidential token accounts for both.
 *
 * WHAT THIS TEACHES
 *   1. Encryption keys are DERIVED, not stored. Each owner signs two short,
 *      human-readable messages; the 64-byte Ed25519 signatures seed an
 *      ElGamal keypair (for the on-chain encrypted balances) and an AES key
 *      (for the owner's fast-to-decrypt balance cache). Sign the same text
 *      again — in this script, in the web app, on another machine — and you
 *      get the same keys. Nothing secret is ever written down.
 *   2. Configuring an account publishes the owner's ElGamal PUBLIC key into
 *      the token account on-chain. That is what senders encrypt to — and it
 *      is exactly why a recipient must configure their account BEFORE anyone
 *      can send them confidential funds.
 *   3. Configuration itself needs a ZK proof (pubkey validity) proving the
 *      ElGamal pubkey is well-formed — your first taste of the proof flow.
 *
 * WHAT TO POINT AT
 *   The two signed message strings printed below (readable text — this is the
 *   same thing Phantom shows in the web app), and the token accounts on the
 *   explorer showing the ConfidentialTransferAccount extension with an
 *   elgamalPubkey field.
 *
 * RUN
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/02-configure-account.ts
 */
import { address, nonDivisibleSequentialInstructionPlan } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token-2022';
import { getCreateConfidentialTransferAccountInstructionPlan } from '@solana-program/token-2022/confidential';
import { getTransferSolInstruction } from '@solana-program/system';

import {
  createTools, deriveCtKeys, executePlan, explorerAddress,
  loadPayer, newOwner, requireState, rpc, writeState,
} from './helpers.ts';

const SOL_FOR_FEES = 20_000_000n; // 0.02 SOL each, so Alice/Bob could pay their own fees later

async function main() {
  console.log('STEP 02 — configure confidential accounts for Alice and Bob (devnet)\n');

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const payer = await loadPayer();
  const tools = createTools(payer);
  console.log(`Mint: ${mint}\n`);

  // Two brand-new wallets. We keep their 32-byte seeds in state.json so the
  // later steps can sign as them again.
  const alice = await newOwner();
  const bob = await newOwner();
  console.log(`Alice: ${alice.signer.address}`);
  console.log(`Bob:   ${bob.signer.address}`);

  console.log('\nFunding both with a little SOL from the payer:');
  await executePlan(
    tools,
    nonDivisibleSequentialInstructionPlan([
      getTransferSolInstruction({ source: payer, destination: alice.signer.address, amount: SOL_FOR_FEES }),
      getTransferSolInstruction({ source: payer, destination: bob.signer.address, amount: SOL_FOR_FEES }),
    ]),
  );

  // --- Key derivation: signatures over READABLE TEXT -----------------------
  // This matches the web app (apps/web/src/lib/confidentialTransfer.ts): the
  // wallet signs plain text, because wallets like Phantom refuse opaque
  // binary signMessage payloads. Deterministic text in -> same keys out.
  console.log('\nDeriving encryption keys from signatures. Each owner signs two messages:');
  console.log(`  "ElGamalSecretKey:${alice.signer.address}:${mint}"`);
  console.log(`  "AeKey:${alice.signer.address}:${mint}"`);
  console.log('(and the same two for Bob — note: per owner AND per mint)');
  const aliceKeys = await deriveCtKeys(alice.signer, mint);
  const bobKeys = await deriveCtKeys(bob.signer, mint);
  console.log('Keys derived. Nothing was stored — signing again re-derives them.');

  // --- Create + configure the confidential token accounts ------------------
  // Each plan: create the ATA, reallocate it to fit the CT extension, prove
  // the ElGamal pubkey is valid (ZK pubkey-validity proof), configure.
  console.log("\nCreating + configuring Alice's confidential token account:");
  await executePlan(
    tools,
    await getCreateConfidentialTransferAccountInstructionPlan({
      payer,
      owner: alice.signer,
      mint,
      rpc,
      elgamalKeypair: aliceKeys.elgamalKeypair,
      aesKey: aliceKeys.aesKey,
    }),
  );

  console.log("\nCreating + configuring Bob's confidential token account:");
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

  const [aliceAta] = await findAssociatedTokenPda({ mint, owner: alice.signer.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const [bobAta] = await findAssociatedTokenPda({ mint, owner: bob.signer.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

  console.log('\nDone. Both accounts now carry a ConfidentialTransferAccount extension');
  console.log('with the owner\'s ElGamal PUBLIC key stored on-chain — that is what');
  console.log('senders encrypt to. This is why recipients must configure BEFORE receiving.');
  console.log(`\nAlice's token account: ${explorerAddress(aliceAta)}`);
  console.log(`Bob's token account:   ${explorerAddress(bobAta)}`);

  writeState({
    alice: { name: 'Alice', address: alice.signer.address, secretBase58: alice.secretBase58, tokenAccount: aliceAta },
    bob: { name: 'Bob', address: bob.signer.address, secretBase58: bob.secretBase58, tokenAccount: bobAta },
  });
}

main().catch(err => {
  console.error('\nSTEP 02 FAILED:', err);
  process.exit(1);
});
