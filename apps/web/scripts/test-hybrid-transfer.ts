/**
 * Test hybrid approach:
 * - Context state for equality and validity2 proofs (smaller)
 * - Inline range proof in the final transfer transaction
 * Run with: npx tsx scripts/test-hybrid-transfer.ts
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
  console.log('=== Hybrid Proof Transfer Test ===\n');

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

  const transferAmount = 100n;
  const newSourceBalance = 900n;

  console.log('\n2. Generating proofs...');

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

  console.log('   Equality proof:', equalityProofBytes.length, 'bytes');
  console.log('   Validity2 proof:', validity2ProofBytes.length, 'bytes');
  console.log('   Range proof:', rangeProofBytes.length, 'bytes');

  // Context state account sizes
  const equalityAccountSize = equalityContextBytes.length + 33;
  const validity2AccountSize = validity2ContextBytes.length + 33;

  console.log('\n3. Creating context state accounts for equality and validity2...');

  const equalityContextKeypair = Keypair.generate();
  const validity2ContextKeypair = Keypair.generate();

  // Transaction 1: Equality proof context state
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

    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    console.log('   Equality context: ✓ SUCCESS -', sig.slice(0, 30) + '...');
    await new Promise(r => setTimeout(r, 1500));
  }

  // Transaction 2: Validity2 proof context state
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

    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    console.log('   Validity2 context: ✓ SUCCESS -', sig.slice(0, 30) + '...');
    await new Promise(r => setTimeout(r, 1500));
  }

  // Transaction 3: Range proof inline (no context state, just verify)
  console.log('\n4. Verifying range proof inline (no context state)...');
  {
    const rangeIxData = new Uint8Array(1 + rangeProofBytes.length);
    rangeIxData[0] = ZK_INSTRUCTION.VerifyBatchedRangeProofU128;
    rangeIxData.set(rangeProofBytes, 1);

    const rangeIx = new TransactionInstruction({
      programId: ZK_PROOF_PROGRAM_ID,
      keys: [],
      data: Buffer.from(rangeIxData),
    });

    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [computeBudgetIx, rangeIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    console.log('   Transaction size:', tx.serialize().length, 'bytes');

    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    console.log('   Range proof inline: ✓ SUCCESS -', sig.slice(0, 30) + '...');
    await new Promise(r => setTimeout(r, 1500));
  }

  // Verify context state accounts
  console.log('\n5. Verifying context state accounts exist...');
  const equalityAccount = await connection.getAccountInfo(equalityContextKeypair.publicKey);
  const validity2Account = await connection.getAccountInfo(validity2ContextKeypair.publicKey);

  console.log('   Equality account:', equalityAccount?.data.length, 'bytes');
  console.log('   Validity2 account:', validity2Account?.data.length, 'bytes');

  console.log('\n=== SUCCESS ===');
  console.log('Hybrid approach works!');
  console.log('- Equality and Validity2: Context state accounts');
  console.log('- Range: Inline verification');
  console.log('\nContext state accounts:');
  console.log('  - Equality:', equalityContextKeypair.publicKey.toBase58());
  console.log('  - Validity2:', validity2ContextKeypair.publicKey.toBase58());
}

main().catch(console.error);
