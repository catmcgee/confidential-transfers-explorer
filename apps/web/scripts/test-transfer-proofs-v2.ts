/**
 * Test script for transfer proofs with correct API usage
 * Run with: npx tsx scripts/test-transfer-proofs-v2.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

// ZK Proof Program Instruction Discriminators (for zk-edge.surfnet.dev)
const ZK_INSTRUCTION = {
  CloseContextState: 0,
  VerifyZeroCiphertext: 1,
  VerifyCiphertextCiphertextEquality: 2,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyPubkeyValidity: 4,
  VerifyPercentageWithCap: 5,
  VerifyBatchedRangeProofU64: 6,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedRangeProofU256: 8,
  VerifyGroupedCiphertext2HandlesValidity: 9,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyGroupedCiphertext3HandlesValidity: 11,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,
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
  console.log('=== Transfer Proofs Test v2 ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  // Request airdrop
  console.log('1. Getting test SOL...');
  try {
    await connection.requestAirdrop(payer.publicKey, 2_000_000_000);
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
  console.log('   Sender pubkey:', Buffer.from(senderPubkey.toBytes()).toString('hex'));

  // Recipient
  const recipientHash = sha512(new Uint8Array([...senderSecretKeyBytes, 1, 2, 3]));
  const recipientSecretScalar = bytesToNumberLE(recipientHash.slice(0, 32)) % ED25519_ORDER;
  const recipientSecretKeyBytes = numberToLEBytes(recipientSecretScalar, 32);
  const recipientElgamalSecretKey = zkSdk.ElGamalSecretKey.fromBytes(recipientSecretKeyBytes);
  const recipientKeypair = zkSdk.ElGamalKeypair.fromSecretKey(recipientElgamalSecretKey);
  const recipientPubkey = recipientKeypair.pubkey();
  console.log('   Recipient pubkey:', Buffer.from(recipientPubkey.toBytes()).toString('hex'));

  // Test amounts
  const sourceBalance = 1000n;
  const transferAmount = 100n;
  const newSourceBalance = sourceBalance - transferAmount;

  console.log('\n3. Testing proof generation...');
  console.log('   Source balance:', sourceBalance.toString());
  console.log('   Transfer amount:', transferAmount.toString());
  console.log('   New source balance:', newSourceBalance.toString());

  // Test BatchedGroupedCiphertext2HandlesValidityProofData
  console.log('\n   a) Testing BatchedGroupedCiphertext2HandlesValidityProofData...');
  try {
    // Create openings for the ciphertexts
    const openingLo = new zkSdk.PedersenOpening();
    const openingHi = new zkSdk.PedersenOpening();

    // For a transfer, we split the amount into lo (16-bit) and hi (32-bit) parts
    // For simplicity, use full amount in lo and 0 in hi
    const amountLo = transferAmount;
    const amountHi = 0n;

    // Create grouped ciphertexts
    const ciphertextLo = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(
      senderPubkey,
      recipientPubkey,
      amountLo,
      openingLo
    );
    const ciphertextHi = zkSdk.GroupedElGamalCiphertext2Handles.encryptWith(
      senderPubkey,
      recipientPubkey,
      amountHi,
      openingHi
    );

    console.log('   Created grouped ciphertexts');
    console.log('   Ciphertext Lo size:', ciphertextLo.toBytes().length);
    console.log('   Ciphertext Hi size:', ciphertextHi.toBytes().length);

    // Create the validity proof
    const validity2ProofData = new zkSdk.BatchedGroupedCiphertext2HandlesValidityProofData(
      senderPubkey,
      recipientPubkey,
      ciphertextLo,
      ciphertextHi,
      amountLo,
      amountHi,
      openingLo,
      openingHi
    );

    console.log('   Validity2 proof size:', validity2ProofData.toBytes().length, 'bytes');

    try {
      validity2ProofData.verify();
      console.log('   ✓ Validity2 proof local verification passed');

      // Try on-chain verification
      const proofBytes = validity2ProofData.toBytes();
      await testOnChainProof(
        connection,
        payer,
        ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity,
        proofBytes,
        'BatchedGroupedCiphertext2HandlesValidity'
      );
    } catch (err) {
      console.error('   ✗ Validity2 proof verification failed:', err);
    }
  } catch (err) {
    console.error('   Failed to create validity2 proof:', err);
  }

  // Test BatchedRangeProofU128Data
  console.log('\n   b) Testing BatchedRangeProofU128Data...');
  try {
    // For range proof, we need to prove:
    // - new source balance (64 bits)
    // - transfer amount lo (16 bits)
    // - transfer amount hi (32 bits)
    // - total transfer amount (16 bits to complete 128)
    // Total = 64 + 16 + 32 + 16 = 128

    const openings = [
      new zkSdk.PedersenOpening(),
      new zkSdk.PedersenOpening(),
      new zkSdk.PedersenOpening(),
      new zkSdk.PedersenOpening(),
    ];

    const amounts = BigUint64Array.from([
      BigInt(newSourceBalance),   // 64 bits - remaining balance
      BigInt(transferAmount),     // 16 bits - amount lo
      0n,                         // 32 bits - amount hi
      BigInt(transferAmount),     // 16 bits - total amount for recipient decryption
    ]);

    const bitLengths = new Uint8Array([64, 16, 32, 16]);  // Must sum to 128

    const commitments = [
      zkSdk.PedersenCommitment.from(amounts[0]!, openings[0]!),
      zkSdk.PedersenCommitment.from(amounts[1]!, openings[1]!),
      zkSdk.PedersenCommitment.from(amounts[2]!, openings[2]!),
      zkSdk.PedersenCommitment.from(amounts[3]!, openings[3]!),
    ];

    console.log('   Amounts:', Array.from(amounts).map(a => a.toString()));
    console.log('   Bit lengths:', Array.from(bitLengths));

    const rangeProofData = new zkSdk.BatchedRangeProofU128Data(
      commitments,
      amounts,
      bitLengths,
      openings
    );

    console.log('   Range proof size:', rangeProofData.toBytes().length, 'bytes');

    try {
      rangeProofData.verify();
      console.log('   ✓ Range proof local verification passed');

      // Try on-chain verification
      const proofBytes = rangeProofData.toBytes();
      await testOnChainProof(
        connection,
        payer,
        ZK_INSTRUCTION.VerifyBatchedRangeProofU128,
        proofBytes,
        'BatchedRangeProofU128'
      );
    } catch (err) {
      console.error('   ✗ Range proof verification failed:', err);
    }
  } catch (err) {
    console.error('   Failed to create range proof:', err);
  }

  // Test CiphertextCommitmentEqualityProofData
  console.log('\n   c) Testing CiphertextCommitmentEqualityProofData...');
  try {
    // For equality proof, we need to prove that a ciphertext encrypts
    // the same value as a Pedersen commitment
    // This is used to prove the new source balance

    // Create an opening for the commitment
    const opening = new zkSdk.PedersenOpening();

    // Encrypt the new source balance using the same opening
    const ciphertext = senderPubkey.encryptWith(newSourceBalance, opening);

    // Create the Pedersen commitment with the same value and opening
    const commitment = zkSdk.PedersenCommitment.from(newSourceBalance, opening);

    console.log('   Created ciphertext for new source balance');
    console.log('   Ciphertext size:', ciphertext.toBytes().length);
    console.log('   Commitment size:', commitment.toBytes().length);

    const equalityProofData = new zkSdk.CiphertextCommitmentEqualityProofData(
      senderKeypair,
      ciphertext,
      commitment,
      opening,
      newSourceBalance
    );

    console.log('   Equality proof size:', equalityProofData.toBytes().length, 'bytes');

    try {
      equalityProofData.verify();
      console.log('   ✓ Equality proof local verification passed');

      // Try on-chain verification
      const proofBytes = equalityProofData.toBytes();
      await testOnChainProof(
        connection,
        payer,
        ZK_INSTRUCTION.VerifyCiphertextCommitmentEquality,
        proofBytes,
        'CiphertextCommitmentEquality'
      );
    } catch (err) {
      console.error('   ✗ Equality proof verification failed:', err);
    }
  } catch (err) {
    console.error('   Failed to create equality proof:', err);
  }

  console.log('\n=== Test Complete ===');
}

async function testOnChainProof(
  connection: Connection,
  payer: Keypair,
  discriminator: number,
  proofBytes: Uint8Array,
  proofName: string
) {
  console.log(`\n   Submitting ${proofName} to on-chain program...`);
  console.log(`   Discriminator: ${discriminator}`);
  console.log(`   Proof size: ${proofBytes.length} bytes`);

  const instructionData = new Uint8Array(1 + proofBytes.length);
  instructionData[0] = discriminator;
  instructionData.set(proofBytes, 1);

  const instruction = new TransactionInstruction({
    programId: ZK_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.from(instructionData),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);

  try {
    const sig = await connection.sendTransaction(transaction, { skipPreflight: false });
    console.log(`   ✓ ${proofName} transaction sent:`, sig);

    await new Promise(r => setTimeout(r, 2000));
    const status = await connection.getSignatureStatus(sig);
    console.log('   Status:', status?.value?.err ? 'FAILED' : 'SUCCESS');
    if (status?.value?.err) {
      console.log('   Error:', JSON.stringify(status.value.err));
    }
  } catch (err: any) {
    console.error(`   ✗ ${proofName} transaction failed:`, err.message?.slice(0, 200));
    if (err.logs) {
      console.log('   Logs:', err.logs.slice(0, 5));
    }
  }
}

main().catch(console.error);
