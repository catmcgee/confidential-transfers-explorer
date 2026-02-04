/**
 * Test sending larger transactions directly to RPC (bypassing web3.js validation)
 * Run with: npx tsx scripts/test-large-tx.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

const ZK_INSTRUCTION = {
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
  console.log('=== Large Transaction Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Payer:', payer.publicKey.toBase58());

  // Create ElGamal keypairs for proof generation
  const senderHash = sha512(payer.secretKey.slice(0, 64));
  const senderSecretScalar = bytesToNumberLE(senderHash.slice(0, 32)) % ED25519_ORDER;
  const senderSecretKeyBytes = numberToLEBytes(senderSecretScalar, 32);
  const senderPubkey = zkSdk.ElGamalKeypair.fromSecretKey(zkSdk.ElGamalSecretKey.fromBytes(senderSecretKeyBytes)).pubkey();

  // Generate range proof
  console.log('\n2. Generating range proof...');
  const openingLo = new zkSdk.PedersenOpening();
  const openingHi = new zkSdk.PedersenOpening();
  const openingLo2 = new zkSdk.PedersenOpening();
  const openingHi2 = new zkSdk.PedersenOpening();

  const commitments = [
    zkSdk.PedersenCommitment.from(100n, openingLo),
    zkSdk.PedersenCommitment.from(0n, openingHi),
    zkSdk.PedersenCommitment.from(100n, openingLo2),
    zkSdk.PedersenCommitment.from(0n, openingHi2),
  ];
  const amounts = BigUint64Array.from([100n, 0n, 100n, 0n]);
  const bitLengths = new Uint8Array([16, 32, 16, 64]);
  const openings = [openingLo, openingHi, openingLo2, openingHi2];

  const rangeProofData = new zkSdk.BatchedRangeProofU128Data(commitments, amounts, bitLengths, openings);
  const rangeProofBytes = rangeProofData.toBytes();
  console.log('   Range proof size:', rangeProofBytes.length, 'bytes');

  // Create context state account first
  const contextKeypair = Keypair.generate();
  const contextSize = 297; // Range context size
  const rentExempt = await connection.getMinimumBalanceForRentExemption(contextSize);

  console.log('\n3. Creating context state account...');
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: contextKeypair.publicKey,
    lamports: rentExempt,
    space: contextSize,
    programId: ZK_PROOF_PROGRAM_ID,
  });

  const { blockhash: createBlockhash } = await connection.getLatestBlockhash();
  const createMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: createBlockhash,
    instructions: [createAccountIx],
  }).compileToV0Message();

  const createTx = new VersionedTransaction(createMsg);
  createTx.sign([payer, contextKeypair]);

  const createSig = await connection.sendTransaction(createTx, { skipPreflight: true });
  console.log('   Created:', createSig.slice(0, 30) + '...');
  await new Promise(r => setTimeout(r, 2000));

  // Now try to send range proof verification directly via RPC
  console.log('\n4. Sending range proof verification directly to RPC...');

  const verifyIxData = new Uint8Array(1 + rangeProofBytes.length);
  verifyIxData[0] = ZK_INSTRUCTION.VerifyBatchedRangeProofU128;
  verifyIxData.set(rangeProofBytes, 1);

  const verifyIx = new TransactionInstruction({
    programId: ZK_PROOF_PROGRAM_ID,
    keys: [
      { pubkey: contextKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(verifyIxData),
  });

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
  const { blockhash } = await connection.getLatestBlockhash();

  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, verifyIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);

  const serialized = tx.serialize();
  const base64Tx = Buffer.from(serialized).toString('base64');

  console.log('   Serialized tx size:', serialized.length, 'bytes');
  console.log('   Base64 tx size:', base64Tx.length, 'chars');

  // Send directly to RPC, bypassing web3.js sendTransaction
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        base64Tx,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        }
      ]
    })
  });

  const result = await response.json();
  console.log('\n5. RPC Response:');
  console.log(JSON.stringify(result, null, 2));

  if (result.result) {
    console.log('\n✓ SUCCESS! Large transaction accepted by RPC');
    console.log('   Signature:', result.result);
  } else if (result.error) {
    console.log('\n✗ FAILED:', result.error.message);

    // Check if it's a size error
    if (result.error.message?.includes('too large')) {
      console.log('\n   The RPC still has transaction size limits.');
      console.log('   Current limit appears to be 1232 bytes raw / 1644 bytes encoded.');
    }
  }
}

main().catch(console.error);
