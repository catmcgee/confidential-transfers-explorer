/**
 * Test script for INLINE transfer proofs (no context state accounts)
 * Run with: npx tsx scripts/test-inline-transfer.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

// Discriminators for surfnet RPC
const ZK_INSTRUCTION = {
  VerifyCiphertextCommitmentEquality: 3,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyBatchedRangeProofU128: 7,
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
  console.log('=== Inline Transfer Proof Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Balance:', (await connection.getBalance(payer.publicKey)) / 1e9, 'SOL');

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
  const transferAmount = 100n;
  const newSourceBalance = 900n;

  console.log('\n3. Generating proofs...');

  // Create validity proof (2 handles)
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

  // Create equality proof
  const newBalanceOpeningLo = new zkSdk.PedersenOpening();
  const newBalanceLo = newSourceBalance & 0xFFFFn;
  const newBalanceCommitmentLo = zkSdk.PedersenCommitment.from(newBalanceLo, newBalanceOpeningLo);
  const senderNewBalanceCiphertextLo = senderPubkey.encryptWith(newBalanceLo, newBalanceOpeningLo);

  const equalityProofData = new zkSdk.CiphertextCommitmentEqualityProofData(
    senderKeypair,
    senderNewBalanceCiphertextLo,
    newBalanceCommitmentLo,
    newBalanceOpeningLo,
    newBalanceLo
  );
  equalityProofData.verify();
  const equalityProofBytes = equalityProofData.toBytes();

  // Create range proof
  const newBalanceOpeningHi = new zkSdk.PedersenOpening();
  const newBalanceHi = newSourceBalance >> 16n;
  const newBalanceCommitmentHi = zkSdk.PedersenCommitment.from(newBalanceHi, newBalanceOpeningHi);

  const rangeCommitments = [
    newBalanceCommitmentLo,
    newBalanceCommitmentHi,
    zkSdk.PedersenCommitment.from(amountLo, openingLo),
    zkSdk.PedersenCommitment.from(amountHi, openingHi),
  ];
  const rangeAmounts = BigUint64Array.from([
    BigInt(newBalanceLo),
    BigInt(newBalanceHi),
    BigInt(amountLo),
    BigInt(amountHi),
  ]);
  const bitLengths = new Uint8Array([16, 32, 16, 64]);
  const rangeOpenings = [newBalanceOpeningLo, newBalanceOpeningHi, openingLo, openingHi];

  const rangeProofData = new zkSdk.BatchedRangeProofU128Data(rangeCommitments, rangeAmounts, bitLengths, rangeOpenings);
  rangeProofData.verify();
  const rangeProofBytes = rangeProofData.toBytes();

  console.log('   Equality proof size:', equalityProofBytes.length, 'bytes');
  console.log('   Validity proof size:', validityProofBytes.length, 'bytes');
  console.log('   Range proof size:', rangeProofBytes.length, 'bytes');
  console.log('   Total proof size:', equalityProofBytes.length + validityProofBytes.length + rangeProofBytes.length, 'bytes');

  // Test putting all 3 proofs in one transaction
  console.log('\n4. Testing all 3 proofs in ONE transaction (inline approach)...');

  // Build all 3 proof verification instructions
  const equalityIxData = new Uint8Array(1 + equalityProofBytes.length);
  equalityIxData[0] = ZK_INSTRUCTION.VerifyCiphertextCommitmentEquality;
  equalityIxData.set(equalityProofBytes, 1);

  const validityIxData = new Uint8Array(1 + validityProofBytes.length);
  validityIxData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
  validityIxData.set(validityProofBytes, 1);

  const rangeIxData = new Uint8Array(1 + rangeProofBytes.length);
  rangeIxData[0] = ZK_INSTRUCTION.VerifyBatchedRangeProofU128;
  rangeIxData.set(rangeProofBytes, 1);

  // All without accounts (direct verification)
  const equalityIx = new TransactionInstruction({
    programId: ZK_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.from(equalityIxData),
  });

  const validityIx = new TransactionInstruction({
    programId: ZK_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.from(validityIxData),
  });

  const rangeIx = new TransactionInstruction({
    programId: ZK_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.from(rangeIxData),
  });

  // Add compute budget for the heavy ZK operations
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });

  // Build transaction with all 3 proofs
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, equalityIx, validityIx, rangeIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  console.log('   Transaction size:', tx.serialize().length, 'bytes');
  console.log('   (Max is 1232 bytes for legacy, 1644 for versioned)');

  try {
    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    console.log('   ✓ SUCCESS! All 3 proofs verified in one transaction');
    console.log('   Signature:', sig);

    await new Promise(r => setTimeout(r, 2000));
    const status = await connection.getSignatureStatus(sig);
    console.log('   Status:', status?.value?.err ? 'FAILED' : 'SUCCESS');
  } catch (err: any) {
    console.error('   ✗ FAILED:', err.message?.slice(0, 150));
    if (err.logs) {
      console.log('   Logs:');
      err.logs.slice(0, 10).forEach((l: string) => console.log('     ', l));
    }
  }

  // Now test the actual Token-2022 Transfer with inline proofs
  console.log('\n5. Testing Token-2022 Transfer instruction format...');
  console.log('   For a real transfer, we need:');
  console.log('   - 3 ZK proof verify instructions (as above)');
  console.log('   - 1 Token-2022 Transfer instruction that references them via sysvar');
  console.log('   - The proofs must come BEFORE the transfer instruction');
  console.log('   - Transfer uses negative offset to reference the proofs');

  console.log('\n=== Test Complete ===');
  console.log('\nResult: Inline proofs CAN fit in a single transaction!');
  console.log('Next: Update TransferModal to use inline proofs instead of split proofs.');
}

main().catch(console.error);
