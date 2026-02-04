/**
 * Test minimal transfer size without range proof
 * Run with: npx tsx scripts/test-minimal-transfer.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const SYSVAR_INSTRUCTIONS_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

const ZK_INSTRUCTION = {
  CloseContextState: 0,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedRangeProofU64: 6,
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
  console.log('=== Minimal Transfer Size Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));

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

  const transferAmount = 100n;
  const newSourceBalance = 900n;

  console.log('\n2. Testing different range proof sizes...');

  // Try BatchedRangeProofU64 instead of U128 - might be smaller
  const newBalanceOpeningLo = new zkSdk.PedersenOpening();
  const newBalanceLo = newSourceBalance & 0xFFFFn;
  const newBalanceCommitmentLo = zkSdk.PedersenCommitment.from(newBalanceLo, newBalanceOpeningLo);

  const newBalanceOpeningHi = new zkSdk.PedersenOpening();
  const newBalanceHi = newSourceBalance >> 16n;
  const newBalanceCommitmentHi = zkSdk.PedersenCommitment.from(newBalanceHi, newBalanceOpeningHi);

  const openingLo = new zkSdk.PedersenOpening();
  const openingHi = new zkSdk.PedersenOpening();
  const amountLo = transferAmount;
  const amountHi = 0n;

  // Try U64 range proof with 2 values
  try {
    const rangeCommitments64 = [
      newBalanceCommitmentLo,
      zkSdk.PedersenCommitment.from(amountLo, openingLo),
    ];
    const rangeAmounts64 = BigUint64Array.from([
      BigInt(newBalanceLo),
      BigInt(amountLo),
    ]);
    const bitLengths64 = new Uint8Array([32, 32]); // Must sum to 64
    const rangeOpenings64 = [newBalanceOpeningLo, openingLo];

    const rangeProofU64 = new zkSdk.BatchedRangeProofU64Data(rangeCommitments64, rangeAmounts64, bitLengths64, rangeOpenings64);
    rangeProofU64.verify();
    console.log('   BatchedRangeProofU64 size:', rangeProofU64.toBytes().length, 'bytes');
  } catch (e: any) {
    console.log('   BatchedRangeProofU64 error:', e.message?.slice(0, 100));
  }

  // U128 range proof (what we've been using)
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
  const bitLengths = new Uint8Array([16, 32, 16, 64]); // Sum to 128
  const rangeOpenings = [newBalanceOpeningLo, newBalanceOpeningHi, openingLo, openingHi];

  const rangeProofU128 = new zkSdk.BatchedRangeProofU128Data(rangeCommitments, rangeAmounts, bitLengths, rangeOpenings);
  rangeProofU128.verify();
  console.log('   BatchedRangeProofU128 size:', rangeProofU128.toBytes().length, 'bytes');

  // Check what the SDK has available for range proofs
  console.log('\n3. Checking available range proof types...');
  console.log('   Available:', Object.keys(zkSdk).filter(k => k.includes('RangeProof')));

  // Build a minimal transaction just to check sizes
  console.log('\n4. Transaction size breakdown...');

  const rangeProofBytes = rangeProofU128.toBytes();

  // Just range proof verification (no accounts)
  const rangeOnlyIxData = new Uint8Array(1 + rangeProofBytes.length);
  rangeOnlyIxData[0] = ZK_INSTRUCTION.VerifyBatchedRangeProofU128;
  rangeOnlyIxData.set(rangeProofBytes, 1);

  const rangeOnlyIx = new TransactionInstruction({
    programId: ZK_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.from(rangeOnlyIxData),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const rangeOnlyMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [rangeOnlyIx],
  }).compileToV0Message();

  const rangeOnlyTx = new VersionedTransaction(rangeOnlyMsg);
  rangeOnlyTx.sign([payer]);
  console.log('   Range proof only tx:', rangeOnlyTx.serialize().length, 'bytes');

  // Just a transfer instruction (mock)
  const transferData = new Uint8Array(230); // Approximate size with encrypted amounts
  transferData[0] = 27;
  transferData[1] = 7;

  const transferOnlyIx = new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_ID, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(transferData),
  });

  const transferOnlyMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [transferOnlyIx],
  }).compileToV0Message();

  const transferOnlyTx = new VersionedTransaction(transferOnlyMsg);
  transferOnlyTx.sign([payer]);
  console.log('   Transfer only tx:', transferOnlyTx.serialize().length, 'bytes');

  // Remaining bytes after range proof
  const remaining = 1232 - rangeOnlyTx.serialize().length;
  console.log('   Remaining after range proof:', remaining, 'bytes');
  console.log('   Transfer instruction size:', transferOnlyTx.serialize().length, '- ~100 (overhead) =', transferOnlyTx.serialize().length - 100, 'bytes');

  console.log('\n5. Analysis:');
  console.log('   Range proof (1001 bytes) takes most of the 1232 byte limit.');
  console.log('   Transfer instruction (~330 bytes with accounts) cannot fit alongside.');
  console.log('\n   Options:');
  console.log('   1. Use split transactions with context state accounts for ALL proofs');
  console.log('   2. Wait for larger transaction limits or proof batching');
  console.log('   3. Check if auditor-free transfers need fewer proofs');
}

main().catch(console.error);
