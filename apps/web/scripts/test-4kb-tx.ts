/**
 * Test if RPC accepts 4KB transactions
 * Run with: npx tsx scripts/test-4kb-tx.ts
 *
 * This sends an actual transaction with range proof + context state
 * to verify if larger transactions are now accepted.
 */

import {
  pipe,
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  getBase64EncodedWireTransaction,
  address,
  blockhash,
  type Instruction,
} from '@solana/kit';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = 'ZkE1Gama1Proof11111111111111111111111111111';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

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

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros++;
  }
  let num = 0n;
  for (const byte of bytes) {
    num = (num << 8n) | BigInt(byte);
  }
  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = ALPHABET[remainder] + result;
  }
  return '1'.repeat(leadingZeros) + result;
}

async function main() {
  console.log('=== 4KB Transaction Limit Test ===\n');
  console.log('RPC URL:', RPC_URL);

  // Generate keypairs
  const payerSecretKey = new Uint8Array(32);
  crypto.getRandomValues(payerSecretKey);
  const payerPublicKey = ed25519.getPublicKey(payerSecretKey);
  const payerAddress = encodeBase58(payerPublicKey);

  const contextSecretKey = new Uint8Array(32);
  crypto.getRandomValues(contextSecretKey);
  const contextPublicKey = ed25519.getPublicKey(contextSecretKey);
  const contextAddress = encodeBase58(contextPublicKey);

  console.log('\n1. Test accounts:');
  console.log('   Payer:', payerAddress);
  console.log('   Context:', contextAddress);

  // Request airdrop
  console.log('\n2. Requesting airdrop...');
  const airdropResponse = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'requestAirdrop',
      params: [payerAddress, 10_000_000_000]
    })
  });
  const airdropData = await airdropResponse.json();
  if (airdropData.error) {
    console.log('   Airdrop error:', airdropData.error.message);
    return;
  }
  console.log('   Airdrop requested:', airdropData.result?.slice(0, 30) + '...');
  await new Promise(r => setTimeout(r, 2000));

  // Generate range proof
  console.log('\n3. Generating range proof...');
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

  // First, create the context account
  console.log('\n4. Creating context state account...');

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
  const recentBlockhash = blockhashData.result.value.blockhash;
  const lastValidBlockHeight = BigInt(blockhashData.result.value.lastValidBlockHeight);

  // Get rent
  const rentResponse = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMinimumBalanceForRentExemption',
      params: [297] // Range context size
    })
  });
  const rentData = await rentResponse.json();
  const rentLamports = BigInt(rentData.result);

  // Build CreateAccount instruction
  const createAccountData = new Uint8Array(4 + 8 + 8 + 32);
  createAccountData.set(numberToLEBytes(0n, 4), 0); // CreateAccount = 0
  createAccountData.set(numberToLEBytes(rentLamports, 8), 4);
  createAccountData.set(numberToLEBytes(297n, 8), 12);

  // Decode ZK program ID
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function decodeBase58(str: string): Uint8Array {
    const bytes: number[] = [];
    for (const char of str) {
      let carry = ALPHABET.indexOf(char);
      if (carry < 0) throw new Error(`Invalid base58 character: ${char}`);
      for (let i = 0; i < bytes.length; i++) {
        carry += bytes[i]! * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }
    for (const char of str) {
      if (char !== '1') break;
      bytes.push(0);
    }
    return new Uint8Array(bytes.reverse());
  }

  createAccountData.set(decodeBase58(ZK_PROOF_PROGRAM_ID), 20);

  const createAccountIx: Instruction = {
    programAddress: address(SYSTEM_PROGRAM_ID),
    accounts: [
      { address: address(payerAddress), role: 3 }, // WRITABLE_SIGNER
      { address: address(contextAddress), role: 3 }, // WRITABLE_SIGNER
    ],
    data: createAccountData,
  };

  // Build and send create account transaction
  const payerKeyPair = await createKeyPairFromBytes(new Uint8Array([...payerSecretKey, ...payerPublicKey]));
  const contextKeyPair = await createKeyPairFromBytes(new Uint8Array([...contextSecretKey, ...contextPublicKey]));

  const createTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(payerAddress), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([createAccountIx], m),
  );

  const createCompiledTx = compileTransaction(createTxMessage);
  const createSignedTx = await signTransaction([payerKeyPair, contextKeyPair], createCompiledTx);
  const createBase64Tx = getBase64EncodedWireTransaction(createSignedTx);

  const createResponse = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [createBase64Tx, { encoding: 'base64', skipPreflight: true }]
    })
  });
  const createResult = await createResponse.json();

  if (createResult.error) {
    console.log('   Failed:', createResult.error.message);
    return;
  }
  console.log('   Created:', createResult.result?.slice(0, 30) + '...');
  await new Promise(r => setTimeout(r, 1000)); // Shorter wait

  // Now try range proof verification with context account
  console.log('\n5. Sending range proof verification (the large transaction)...');

  // Build range proof instruction
  const verifyIxData = new Uint8Array(1 + rangeProofBytes.length);
  verifyIxData[0] = 7; // VerifyBatchedRangeProofU128
  verifyIxData.set(rangeProofBytes, 1);

  const verifyIx: Instruction = {
    programAddress: address(ZK_PROOF_PROGRAM_ID),
    accounts: [
      { address: address(contextAddress), role: 1 }, // WRITABLE
      { address: address(payerAddress), role: 0 }, // READONLY
    ],
    data: verifyIxData,
  };

  // Get fresh blockhash
  const blockhash2Response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'finalized' }]
    })
  });
  const blockhash2Data = await blockhash2Response.json();

  const verifyTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(payerAddress), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(blockhash2Data.result.value.blockhash), lastValidBlockHeight: BigInt(blockhash2Data.result.value.lastValidBlockHeight) },
      m
    ),
    (m) => appendTransactionMessageInstructions([verifyIx], m),
  );

  const verifyCompiledTx = compileTransaction(verifyTxMessage);
  const verifySignedTx = await signTransaction([payerKeyPair], verifyCompiledTx);
  const verifyBase64Tx = getBase64EncodedWireTransaction(verifySignedTx);

  // Decode to check size
  const verifyTxBytes = Uint8Array.from(atob(verifyBase64Tx), c => c.charCodeAt(0));
  console.log('   Transaction size:', verifyTxBytes.length, 'bytes');
  console.log('   Base64 size:', verifyBase64Tx.length, 'chars');

  const verifyResponse = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [verifyBase64Tx, { encoding: 'base64', skipPreflight: false }]
    })
  });
  const verifyResult = await verifyResponse.json();

  console.log('\n6. Result:');
  if (verifyResult.result) {
    console.log('   ✅ SUCCESS! Large transaction accepted!');
    console.log('   Signature:', verifyResult.result);
    console.log('\n   The RPC now supports larger transactions (4KB).');
    console.log('   Confidential transfers should now work!');
  } else if (verifyResult.error) {
    console.log('   ❌ FAILED:', verifyResult.error.message);

    if (verifyResult.error.message?.includes('too large')) {
      console.log('\n   The RPC still has the 1232 byte transaction limit.');
      console.log('   The 4KB transaction support may not be enabled yet.');
      console.log('\n   Error details:', JSON.stringify(verifyResult.error, null, 2));
    }
  }
}

main().catch(console.error);
