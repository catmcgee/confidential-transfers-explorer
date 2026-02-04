/**
 * Test creating context state and verifying proof in ONE atomic transaction
 * Run with: npx tsx scripts/test-atomic-context.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

const ZK_INSTRUCTION = {
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
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
  console.log('=== Atomic Context State Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Payer:', payer.publicKey.toBase58());

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
  const recipientPubkey = zkSdk.ElGamalKeypair.fromSecretKey(zkSdk.ElGamalSecretKey.fromBytes(recipientSecretKeyBytes)).pubkey();

  // Create validity proof
  const openingLo = new zkSdk.PedersenOpening();
  const openingHi = new zkSdk.PedersenOpening();
  const ciphertextLo = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(senderPubkey, recipientPubkey, 100n, openingLo);
  const ciphertextHi = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(senderPubkey, recipientPubkey, 0n, openingHi);

  const validity2ProofData = new zkSdk.BatchedGroupedCiphertext2HandlesValidityProofData(
    senderPubkey, recipientPubkey,
    ciphertextLo, ciphertextHi,
    100n, 0n,
    openingLo, openingHi
  );
  const validityProofBytes = validity2ProofData.toBytes();
  const validityContextBytes = validity2ProofData.context().toBytes();

  console.log('2. Proof sizes:');
  console.log('   Proof data:', validityProofBytes.length, 'bytes');
  console.log('   Context data:', validityContextBytes.length, 'bytes');

  // Try different account sizes based on working examples
  const sizesToTest = [
    validityContextBytes.length + 32 + 1, // Context + authority pubkey + discriminator
    288,  // Size of working account
    369,  // Size of other working account
    validityContextBytes.length + 64,
  ];

  console.log('\n3. Testing ATOMIC create + verify...\n');

  for (const size of sizesToTest) {
    const contextStateKeypair = Keypair.generate();
    const rentExempt = await connection.getMinimumBalanceForRentExemption(size);

    // Create account instruction
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: contextStateKeypair.publicKey,
      lamports: rentExempt,
      space: size,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    // Verify proof instruction (immediately after create)
    const verifyIxData = new Uint8Array(1 + validityProofBytes.length);
    verifyIxData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    verifyIxData.set(validityProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [
        { pubkey: contextStateKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // authority
      ],
      data: Buffer.from(verifyIxData),
    });

    // Compute budget for ZK operations
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 500_000,
    });

    // Build ATOMIC transaction with both instructions
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, createAccountIx, verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer, contextStateKeypair]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log(`Size ${size}: ✓ SUCCESS - ${sig.slice(0, 30)}...`);

      // Verify the account was created and populated
      await new Promise(r => setTimeout(r, 1500));
      const accountInfo = await connection.getAccountInfo(contextStateKeypair.publicKey);
      if (accountInfo) {
        console.log(`   Account data: ${accountInfo.data.length} bytes`);
        console.log(`   First 32 bytes: ${accountInfo.data.slice(0, 32).toString('hex')}`);
      }
      break; // Success!
    } catch (err: any) {
      const logs = err.logs || [];
      const errorLog = logs.find((l: string) => l.includes('failed:') || l.includes('invalid')) || err.message?.slice(0, 80);
      console.log(`Size ${size}: ✗ FAILED`);
      console.log(`   Error: ${errorLog}`);
    }
  }

  // Also test without context state - just verify proof directly
  console.log('\n4. Testing direct proof verification (no context state)...');
  {
    const verifyIxData = new Uint8Array(1 + validityProofBytes.length);
    verifyIxData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    verifyIxData.set(validityProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [], // No accounts
      data: Buffer.from(verifyIxData),
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
      console.log(`Direct verify: ✓ SUCCESS - ${sig.slice(0, 30)}...`);
    } catch (err: any) {
      console.log(`Direct verify: ✗ FAILED - ${err.message?.slice(0, 60)}`);
    }
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
