/**
 * Test script for context state proof verification - investigating account format
 * Run with: npx tsx scripts/test-context-state-v2.ts
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

// Context state sizes - let's try different sizes
const CONTEXT_STATE_SIZES = {
  equality: [176, 200, 256, 320],
  validity2: [256, 304, 320, 400, 512],
  rangeU128: [176, 200, 256],
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
  console.log('=== Context State Investigation ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Balance:', (await connection.getBalance(payer.publicKey)) / 1e9, 'SOL');

  // Create ElGamal keypairs
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

  // Create validity proof
  const openingLo = new zkSdk.PedersenOpening();
  const openingHi = new zkSdk.PedersenOpening();
  const ciphertextLo = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(
    senderPubkey, recipientPubkey, 100n, openingLo
  );
  const ciphertextHi = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(
    senderPubkey, recipientPubkey, 0n, openingHi
  );

  const validity2ProofData = new zkSdk.BatchedGroupedCiphertext2HandlesValidityProofData(
    senderPubkey, recipientPubkey,
    ciphertextLo, ciphertextHi,
    100n, 0n,
    openingLo, openingHi
  );
  const validityProofBytes = validity2ProofData.toBytes();
  const proofContextBytes = validity2ProofData.context().toBytes();

  console.log('\n2. Proof info:');
  console.log('   Proof size:', validityProofBytes.length, 'bytes');
  console.log('   Context size:', proofContextBytes.length, 'bytes');

  // Test different approaches
  console.log('\n3. Testing account sizes...');

  for (const size of CONTEXT_STATE_SIZES.validity2) {
    const contextStateKeypair = Keypair.generate();
    const rentExempt = await connection.getMinimumBalanceForRentExemption(size);

    // Create account
    const { blockhash: createBlockhash } = await connection.getLatestBlockhash();
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: contextStateKeypair.publicKey,
      lamports: rentExempt,
      space: size,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const createMsg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: createBlockhash,
      instructions: [createAccountIx],
    }).compileToV0Message();

    const createTx = new VersionedTransaction(createMsg);
    createTx.sign([payer, contextStateKeypair]);

    try {
      await connection.sendTransaction(createTx, { skipPreflight: true });
      await new Promise(r => setTimeout(r, 1500));
    } catch {
      console.log(`   Size ${size}: Failed to create account`);
      continue;
    }

    // Try to verify proof with this account
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
      console.log(`   Size ${size}: ✓ SUCCESS - ${sig.slice(0, 20)}...`);
    } catch (err: any) {
      const errorMsg = err.logs?.find((l: string) => l.includes('failed:')) || err.message?.slice(0, 60);
      console.log(`   Size ${size}: ✗ FAILED - ${errorMsg}`);
    }
  }

  // Test with proof context prepended to data
  console.log('\n4. Testing with context in instruction data...');
  {
    const contextStateKeypair = Keypair.generate();
    const size = proofContextBytes.length + 100; // Context size + some buffer
    const rentExempt = await connection.getMinimumBalanceForRentExemption(size);

    // Create account
    const { blockhash: createBlockhash } = await connection.getLatestBlockhash();
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: contextStateKeypair.publicKey,
      lamports: rentExempt,
      space: size,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const createMsg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: createBlockhash,
      instructions: [createAccountIx],
    }).compileToV0Message();

    const createTx = new VersionedTransaction(createMsg);
    createTx.sign([payer, contextStateKeypair]);

    try {
      await connection.sendTransaction(createTx, { skipPreflight: true });
      await new Promise(r => setTimeout(r, 1500));
    } catch {
      console.log('   Failed to create account');
    }

    // Try with context info byte at start
    // Format: discriminator (1) + context_info (1: 0=no context, 1=write context) + proof_data
    const instructionData = new Uint8Array(2 + validityProofBytes.length);
    instructionData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    instructionData[1] = 1; // Indicate we want to write context
    instructionData.set(validityProofBytes, 2);

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
      console.log('   With context flag: ✓ SUCCESS -', sig.slice(0, 30));
    } catch (err: any) {
      console.log('   With context flag: ✗ FAILED -', err.logs?.slice(0, 3) || err.message?.slice(0, 60));
    }
  }

  // Alternative: Maybe proofs should go in the record (context) account first, then referenced
  console.log('\n5. Checking Solana ZK proof program docs format...');
  console.log('   The standard format for context state verification might be different.');
  console.log('   Let me check if this custom RPC supports context states at all...');

  // Try one more thing: Maybe the account needs to be pre-initialized with specific data
  {
    const contextStateKeypair = Keypair.generate();
    const contextSize = proofContextBytes.length + 32 + 1 + 1; // context + pubkey + discriminator + padding
    const rentExempt = await connection.getMinimumBalanceForRentExemption(contextSize);

    // Create account
    const { blockhash: createBlockhash } = await connection.getLatestBlockhash();
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: contextStateKeypair.publicKey,
      lamports: rentExempt,
      space: contextSize,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const createMsg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: createBlockhash,
      instructions: [createAccountIx],
    }).compileToV0Message();

    const createTx = new VersionedTransaction(createMsg);
    createTx.sign([payer, contextStateKeypair]);

    try {
      await connection.sendTransaction(createTx, { skipPreflight: true });
      await new Promise(r => setTimeout(r, 1500));
      console.log('   Account created with size:', contextSize);
    } catch {
      console.log('   Failed to create account');
    }

    // Check if maybe the proof needs to be split differently
    // Or if the context state verification is simply not supported on this RPC
  }

  console.log('\n=== Conclusion ===');
  console.log('The ZK proof verification works WITHOUT context state accounts.');
  console.log('Context state accounts fail with "invalid account data".');
  console.log('This might mean:');
  console.log('1. This custom RPC doesn\'t support context state accounts');
  console.log('2. We need to use INLINE proofs instead of split proofs');
  console.log('3. The context state format is different on this RPC');
}

main().catch(console.error);
