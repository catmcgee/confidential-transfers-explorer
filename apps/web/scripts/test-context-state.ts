/**
 * Test script for context state proof verification
 * Run with: npx tsx scripts/test-context-state.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

// Discriminators for surfnet RPC
const ZK_INSTRUCTION = {
  CloseContextState: 0,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyBatchedRangeProofU128: 7,
} as const;

// Context state sizes
const CONTEXT_STATE_SIZES = {
  equality: 176,
  validity2: 304,
  rangeU128: 176,
} as const;

const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) + BigInt(bytes[i]!);
  }
  return result;
}

function numberToLEBytes(n: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let value = n;
  for (let i = 0; i < length; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

async function main() {
  console.log('=== Context State Proof Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  // Request airdrop
  console.log('1. Getting test SOL...');
  try {
    await connection.requestAirdrop(payer.publicKey, 5_000_000_000);
    await new Promise(r => setTimeout(r, 2000));
    const balance = await connection.getBalance(payer.publicKey);
    console.log('   Balance:', balance / 1e9, 'SOL');
  } catch (err) {
    console.error('   Airdrop failed:', err);
    return;
  }

  // Create ElGamal keypairs
  console.log('\n2. Creating ElGamal keypairs...');
  const senderHash = sha512(payer.secretKey.slice(0, 64));
  const senderSecretScalar = bytesToNumberLE(senderHash.slice(0, 32)) % ED25519_ORDER;
  const senderSecretKeyBytes = numberToLEBytes(senderSecretScalar, 32);

  const senderElgamalSecretKey = zkSdk.ElGamalSecretKey.fromBytes(senderSecretKeyBytes);
  const senderKeypair = zkSdk.ElGamalKeypair.fromSecretKey(senderElgamalSecretKey);
  const senderPubkey = senderKeypair.pubkey();

  const recipientHash = sha512(new Uint8Array([...senderSecretKeyBytes, 1, 2, 3]));
  const recipientSecretScalar = bytesToNumberLE(recipientHash.slice(0, 32)) % ED25519_ORDER;
  const recipientSecretKeyBytes = numberToLEBytes(recipientSecretScalar, 32);
  const recipientElgamalSecretKey = zkSdk.ElGamalSecretKey.fromBytes(recipientSecretKeyBytes);
  const recipientKeypair = zkSdk.ElGamalKeypair.fromSecretKey(recipientElgamalSecretKey);
  const recipientPubkey = recipientKeypair.pubkey();

  // Test amounts
  const sourceBalance = 1000n;
  const transferAmount = 100n;
  const newSourceBalance = sourceBalance - transferAmount;

  console.log('\n3. Creating proofs...');

  // Create validity proof
  const openingLo = new zkSdk.PedersenOpening();
  const openingHi = new zkSdk.PedersenOpening();
  const amountLo = transferAmount;
  const amountHi = 0n;

  const ciphertextLo = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(
    senderPubkey, recipientPubkey, amountLo, openingLo
  );
  const ciphertextHi = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(
    senderPubkey, recipientPubkey, amountHi, openingHi
  );

  const validity2ProofData = new zkSdk.BatchedGroupedCiphertext2HandlesValidityProofData(
    senderPubkey, recipientPubkey,
    ciphertextLo, ciphertextHi,
    amountLo, amountHi,
    openingLo, openingHi
  );
  validity2ProofData.verify();
  const validityProofBytes = validity2ProofData.toBytes();
  console.log('   Validity proof size:', validityProofBytes.length, 'bytes');

  // Generate a context state keypair
  console.log('\n4. Creating context state account...');
  const contextStateKeypair = Keypair.generate();
  console.log('   Context state address:', contextStateKeypair.publicKey.toBase58());

  // Calculate rent for context state
  const rentExempt = await connection.getMinimumBalanceForRentExemption(CONTEXT_STATE_SIZES.validity2);
  console.log('   Rent exempt:', rentExempt / 1e9, 'SOL');

  // Create context state account first
  const { blockhash: createBlockhash } = await connection.getLatestBlockhash();

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: contextStateKeypair.publicKey,
    lamports: rentExempt,
    space: CONTEXT_STATE_SIZES.validity2,
    programId: ZK_PROOF_PROGRAM_ID,
  });

  const createMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: createBlockhash,
    instructions: [createAccountIx],
  }).compileToV0Message();

  const createTx = new VersionedTransaction(createMsg);
  createTx.sign([payer, contextStateKeypair]);

  console.log('\n5. Creating context state account on-chain...');
  try {
    const sig = await connection.sendTransaction(createTx, { skipPreflight: false });
    console.log('   ✓ Account created:', sig);
    await new Promise(r => setTimeout(r, 2000));
  } catch (err: any) {
    console.error('   ✗ Failed to create account:', err.message?.slice(0, 200));
    if (err.logs) console.log('   Logs:', err.logs.slice(0, 5));
    return;
  }

  // Now test proof verification with context state
  console.log('\n6. Testing proof verification WITH context state account...');

  // Format 1: Just discriminator + proof data (like we do now)
  console.log('\n   Testing Format 1: discriminator + proof_data...');
  {
    const instructionData = new Uint8Array(1 + validityProofBytes.length);
    instructionData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    instructionData.set(validityProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [
        { pubkey: contextStateKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(instructionData),
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log('   ✓ Format 1 SUCCESS:', sig);
    } catch (err: any) {
      console.error('   ✗ Format 1 FAILED:', err.message?.slice(0, 150));
      if (err.logs) {
        console.log('   Logs:');
        err.logs.forEach((l: string) => console.log('     ', l));
      }
    }
  }

  // Format 2: proof_context + proof_data (some programs expect context first)
  console.log('\n   Testing Format 2: context_offset + proof_data...');
  {
    // The ZK proof program might expect an offset indicator for where to write context
    const proofContext = validity2ProofData.context().toBytes();
    console.log('   Proof context size:', proofContext.length);

    // Try: discriminator + context + proof
    const instructionData = new Uint8Array(1 + validityProofBytes.length);
    instructionData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    instructionData.set(validityProofBytes, 1);

    // Different account order - authority as signer
    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [
        { pubkey: contextStateKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // Authority as signer
      ],
      data: Buffer.from(instructionData),
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log('   ✓ Format 2 SUCCESS:', sig);
    } catch (err: any) {
      console.error('   ✗ Format 2 FAILED:', err.message?.slice(0, 150));
      if (err.logs) {
        console.log('   Logs:');
        err.logs.slice(0, 10).forEach((l: string) => console.log('     ', l));
      }
    }
  }

  // Format 3: No accounts (like the working test)
  console.log('\n   Testing Format 3: No accounts (direct verify)...');
  {
    const instructionData = new Uint8Array(1 + validityProofBytes.length);
    instructionData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    instructionData.set(validityProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [], // No accounts
      data: Buffer.from(instructionData),
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log('   ✓ Format 3 SUCCESS:', sig);
    } catch (err: any) {
      console.error('   ✗ Format 3 FAILED:', err.message?.slice(0, 150));
    }
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
