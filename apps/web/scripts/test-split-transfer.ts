/**
 * Test split proof confidential transfer
 * Creates context state accounts for each proof, then references them in transfer
 * Run with: npx tsx scripts/test-split-transfer.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

const ZK_INSTRUCTION = {
  CloseContextState: 0,
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
  console.log('=== Split Proof Confidential Transfer Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Payer:', payer.publicKey.toBase58());

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
  const recipientPubkey = zkSdk.ElGamalKeypair.fromSecretKey(zkSdk.ElGamalSecretKey.fromBytes(recipientSecretKeyBytes)).pubkey();

  // Test amounts
  const transferAmount = 100n;
  const newSourceBalance = 900n;

  console.log('\n3. Generating all three proofs...');

  // === Validity2 Proof ===
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
  const validity2ProofBytes = validity2ProofData.toBytes();
  const validity2ContextBytes = validity2ProofData.context().toBytes();

  // === Equality Proof ===
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
  const equalityProofBytes = equalityProofData.toBytes();
  const equalityContextBytes = equalityProofData.context().toBytes();

  // === Range Proof ===
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
  const rangeProofBytes = rangeProofData.toBytes();
  const rangeContextBytes = rangeProofData.context().toBytes();

  console.log('   Equality proof:', equalityProofBytes.length, 'bytes, context:', equalityContextBytes.length);
  console.log('   Validity2 proof:', validity2ProofBytes.length, 'bytes, context:', validity2ContextBytes.length);
  console.log('   Range proof:', rangeProofBytes.length, 'bytes, context:', rangeContextBytes.length);

  // Calculate context state account sizes (context + 32 byte authority + 1 byte discriminator)
  const equalityAccountSize = equalityContextBytes.length + 33;
  const validity2AccountSize = validity2ContextBytes.length + 33;
  const rangeAccountSize = rangeContextBytes.length + 33;

  console.log('\n4. Creating context state accounts (atomic create + verify)...');
  console.log('   Account sizes:', equalityAccountSize, validity2AccountSize, rangeAccountSize);

  // Create all 3 context state accounts
  const equalityContextKeypair = Keypair.generate();
  const validity2ContextKeypair = Keypair.generate();
  const rangeContextKeypair = Keypair.generate();

  // === Transaction 1: Create + Verify Equality Proof ===
  {
    const rentExempt = await connection.getMinimumBalanceForRentExemption(equalityAccountSize);
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: equalityContextKeypair.publicKey,
      lamports: rentExempt,
      space: equalityAccountSize,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const verifyIxData = new Uint8Array(1 + equalityProofBytes.length);
    verifyIxData[0] = ZK_INSTRUCTION.VerifyCiphertextCommitmentEquality;
    verifyIxData.set(equalityProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [
        { pubkey: equalityContextKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(verifyIxData),
    });

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, createAccountIx, verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer, equalityContextKeypair]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log('   Equality context: ✓ SUCCESS -', sig.slice(0, 30) + '...');
      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      console.log('   Equality context: ✗ FAILED -', err.logs?.slice(-3) || err.message?.slice(0, 80));
      return;
    }
  }

  // === Transaction 2: Create + Verify Validity2 Proof ===
  {
    const rentExempt = await connection.getMinimumBalanceForRentExemption(validity2AccountSize);
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: validity2ContextKeypair.publicKey,
      lamports: rentExempt,
      space: validity2AccountSize,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const verifyIxData = new Uint8Array(1 + validity2ProofBytes.length);
    verifyIxData[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    verifyIxData.set(validity2ProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [
        { pubkey: validity2ContextKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(verifyIxData),
    });

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, createAccountIx, verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer, validity2ContextKeypair]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log('   Validity2 context: ✓ SUCCESS -', sig.slice(0, 30) + '...');
      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      console.log('   Validity2 context: ✗ FAILED -', err.logs?.slice(-3) || err.message?.slice(0, 80));
      return;
    }
  }

  // === Transaction 3: Create + Verify Range Proof ===
  {
    const rentExempt = await connection.getMinimumBalanceForRentExemption(rangeAccountSize);
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: rangeContextKeypair.publicKey,
      lamports: rentExempt,
      space: rangeAccountSize,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const verifyIxData = new Uint8Array(1 + rangeProofBytes.length);
    verifyIxData[0] = ZK_INSTRUCTION.VerifyBatchedRangeProofU128;
    verifyIxData.set(rangeProofBytes, 1);

    const verifyIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [
        { pubkey: rangeContextKeypair.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(verifyIxData),
    });

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, createAccountIx, verifyIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer, rangeContextKeypair]);

    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      console.log('   Range context: ✓ SUCCESS -', sig.slice(0, 30) + '...');
      await new Promise(r => setTimeout(r, 1500));
    } catch (err: any) {
      console.log('   Range context: ✗ FAILED -', err.logs?.slice(-3) || err.message?.slice(0, 80));
      return;
    }
  }

  // Verify all context state accounts exist
  console.log('\n5. Verifying context state accounts...');
  const equalityAccount = await connection.getAccountInfo(equalityContextKeypair.publicKey);
  const validity2Account = await connection.getAccountInfo(validity2ContextKeypair.publicKey);
  const rangeAccount = await connection.getAccountInfo(rangeContextKeypair.publicKey);

  console.log('   Equality account:', equalityAccount?.data.length, 'bytes');
  console.log('   Validity2 account:', validity2Account?.data.length, 'bytes');
  console.log('   Range account:', rangeAccount?.data.length, 'bytes');

  console.log('\n=== SUCCESS ===');
  console.log('All 3 context state accounts created and proofs verified!');
  console.log('Context state account pubkeys:');
  console.log('  - Equality:', equalityContextKeypair.publicKey.toBase58());
  console.log('  - Validity2:', validity2ContextKeypair.publicKey.toBase58());
  console.log('  - Range:', rangeContextKeypair.publicKey.toBase58());
  console.log('\nNext step: Use these accounts in the actual Token-2022 Transfer instruction');
}

main().catch(console.error);
