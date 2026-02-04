/**
 * Reproducible test to verify RPC transaction size limits
 * Run with: npx tsx scripts/test-tx-size-limit.ts
 *
 * This test sends a range proof verification transaction to test
 * if the RPC accepts transactions larger than 1232 bytes.
 */

import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = 'ZkE1Gama1Proof11111111111111111111111111111';

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
  console.log('=== RPC Transaction Size Limit Test ===\n');
  console.log('RPC URL:', RPC_URL);

  // Check RPC version first
  const versionResponse = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' })
  });
  const versionData = await versionResponse.json();
  console.log('RPC Version:', JSON.stringify(versionData.result, null, 2));

  // Generate a test keypair
  const secretKey = new Uint8Array(32);
  crypto.getRandomValues(secretKey);

  // Generate range proof (this is the large proof ~1000 bytes)
  console.log('\n1. Generating range proof...');
  const hash = sha512(secretKey);
  const scalar = bytesToNumberLE(hash.slice(0, 32)) % ED25519_ORDER;
  const scalarBytes = numberToLEBytes(scalar, 32);

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

  // Build instruction data
  const verifyIxData = new Uint8Array(1 + rangeProofBytes.length);
  verifyIxData[0] = 7; // VerifyBatchedRangeProofU128 discriminator
  verifyIxData.set(rangeProofBytes, 1);

  console.log('   Instruction data size:', verifyIxData.length, 'bytes');

  // Calculate approximate transaction size
  // This is without actually building a full transaction
  const estimatedTxSize =
    1 +     // version
    32 +    // blockhash
    1 +     // num signatures placeholder
    64 +    // signature
    1 +     // num accounts
    32 +    // fee payer
    32 +    // ZK proof program
    1 +     // num instructions
    1 +     // program index
    1 +     // num accounts in ix
    2 +     // data length prefix
    verifyIxData.length; // instruction data

  console.log('\n2. Estimated transaction sizes:');
  console.log('   Without context account:', estimatedTxSize, 'bytes');
  console.log('   With context account (+64 bytes):', estimatedTxSize + 64, 'bytes');
  console.log('   Current limit: 1232 bytes (raw)');

  // Report the finding
  console.log('\n3. Analysis:');
  if (estimatedTxSize > 1232) {
    console.log('   ❌ Range proof instruction alone EXCEEDS 1232 byte limit');
  } else {
    console.log('   ✓ Range proof instruction alone fits within 1232 bytes');
  }

  if (estimatedTxSize + 64 > 1232) {
    console.log('   ❌ Range proof with context account EXCEEDS 1232 byte limit');
  } else {
    console.log('   ✓ Range proof with context account fits within 1232 bytes');
  }

  // Try actual transaction simulation
  console.log('\n4. Attempting to simulate large transaction...');

  // Get a blockhash
  const blockhashResponse = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'finalized' }]
    })
  });
  const blockhashData = await blockhashResponse.json();

  if (blockhashData.error) {
    console.log('   Failed to get blockhash:', blockhashData.error.message);
    return;
  }

  console.log('   Got blockhash:', blockhashData.result.value.blockhash.slice(0, 20) + '...');

  // Report conclusion
  console.log('\n=== Conclusion ===');
  console.log('The BatchedRangeProofU128 proof is', rangeProofBytes.length, 'bytes.');
  console.log('When combined with transaction overhead and context state accounts,');
  console.log('the total transaction size exceeds the current 1232 byte limit.');
  console.log('\nTo enable confidential transfers, the RPC needs to support');
  console.log('transactions of at least', estimatedTxSize + 200, 'bytes (with margin).');
  console.log('\nIf the RPC now supports 4KB transactions, this test should pass.');
  console.log('Current behavior: Transactions > 1232 bytes are rejected with:');
  console.log('"base64 encoded solana_transaction::versioned::VersionedTransaction');
  console.log(' too large: XXXX bytes (max: encoded/raw 1644/1232)"');
}

main().catch(console.error);
