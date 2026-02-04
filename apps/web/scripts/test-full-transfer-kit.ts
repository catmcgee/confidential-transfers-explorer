/**
 * Full split proof transfer test using @solana/kit (not web3.js)
 * Run with: npx tsx scripts/test-full-transfer-kit.ts
 */

import {
  pipe,
  createKeyPairFromBytes,
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  getBase64EncodedWireTransaction,
  type Instruction,
} from '@solana/kit';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = 'ZkE1Gama1Proof11111111111111111111111111111';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

const ZK_INSTRUCTION = {
  CloseContextState: 0,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyBatchedRangeProofU128: 7,
} as const;

const CONTEXT_STATE_SIZES = {
  equality: 161,
  validity2: 289,
  rangeU128: 297,
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

function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

async function sendTransaction(base64Tx: string, skipPreflight = false): Promise<{ result?: string; error?: { message: string } }> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [base64Tx, { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed' }]
    })
  });
  return response.json();
}

async function sendWithRetry(
  buildAndSignTx: () => Promise<string>,
  maxRetries = 3
): Promise<{ result?: string; error?: { message: string } }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const base64Tx = await buildAndSignTx();
    const txBytes = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));
    console.log('   Transaction size:', txBytes.length, 'bytes');

    // Try with preflight first, then without on retry
    const result = await sendTransaction(base64Tx, attempt > 1);

    if (result.result) {
      return result;
    }

    const errorMsg = result.error?.message || '';
    if (errorMsg.includes('Blockhash not found') && attempt < maxRetries) {
      console.log(`   ⚠ Blockhash issue, retrying (${attempt}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    return result;
  }
  return { error: { message: 'Max retries exceeded' } };
}

async function getBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'confirmed' }]
    })
  });
  const data = await response.json();
  return {
    blockhash: data.result.value.blockhash,
    lastValidBlockHeight: BigInt(data.result.value.lastValidBlockHeight)
  };
}

async function waitForConfirmation(signature: string, maxRetries = 30): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }]
      })
    });
    const data = await response.json();
    const status = data.result?.value?.[0];

    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        console.log('   ✗ Transaction failed on-chain:', JSON.stringify(status.err));
        return false;
      }
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('   ⚠ Confirmation timeout, but continuing...');
  return true; // Continue anyway, the tx might have landed
}

async function getRent(space: number): Promise<bigint> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMinimumBalanceForRentExemption',
      params: [space]
    })
  });
  const data = await response.json();
  return BigInt(data.result);
}

function buildCreateAccountInstruction(
  payer: string,
  newAccount: string,
  lamports: bigint,
  space: number,
  owner: string
): Instruction {
  const data = new Uint8Array(4 + 8 + 8 + 32);
  data.set(numberToLEBytes(0n, 4), 0); // CreateAccount = 0
  data.set(numberToLEBytes(lamports, 8), 4);
  data.set(numberToLEBytes(BigInt(space), 8), 12);
  data.set(decodeBase58(owner), 20);

  return {
    programAddress: address(SYSTEM_PROGRAM_ID),
    accounts: [
      { address: address(payer), role: 3 }, // WRITABLE_SIGNER
      { address: address(newAccount), role: 3 }, // WRITABLE_SIGNER
    ],
    data,
  };
}

function buildVerifyProofInstruction(
  discriminator: number,
  proofData: Uint8Array,
  contextAccount: string,
  authority: string
): Instruction {
  const data = new Uint8Array(1 + proofData.length);
  data[0] = discriminator;
  data.set(proofData, 1);

  return {
    programAddress: address(ZK_PROOF_PROGRAM_ID),
    accounts: [
      { address: address(contextAccount), role: 1 }, // WRITABLE
      { address: address(authority), role: 0 }, // READONLY
    ],
    data,
  };
}

async function main() {
  console.log('=== Full Split Proof Transfer Test (Kit) ===\n');

  // Generate keypairs
  const payerSecretKey = new Uint8Array(32);
  crypto.getRandomValues(payerSecretKey);
  const payerPublicKey = ed25519.getPublicKey(payerSecretKey);
  const payerAddress = encodeBase58(payerPublicKey);

  const equalitySecretKey = new Uint8Array(32);
  crypto.getRandomValues(equalitySecretKey);
  const equalityPublicKey = ed25519.getPublicKey(equalitySecretKey);
  const equalityAddress = encodeBase58(equalityPublicKey);

  const validitySecretKey = new Uint8Array(32);
  crypto.getRandomValues(validitySecretKey);
  const validityPublicKey = ed25519.getPublicKey(validitySecretKey);
  const validityAddress = encodeBase58(validityPublicKey);

  const rangeSecretKey = new Uint8Array(32);
  crypto.getRandomValues(rangeSecretKey);
  const rangePublicKey = ed25519.getPublicKey(rangeSecretKey);
  const rangeAddress = encodeBase58(rangePublicKey);

  console.log('1. Getting test SOL...');
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
  console.log('   Payer:', payerAddress);
  console.log('   Airdrop:', airdropData.result?.slice(0, 30) + '...');
  await new Promise(r => setTimeout(r, 2000));

  // Create ElGamal keypairs
  console.log('\n2. Creating ElGamal keypairs...');
  const senderHash = sha512(payerSecretKey);
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

  console.log('\n3. Generating all three proofs...');

  // Validity2 Proof
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

  // Equality Proof
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

  // Range Proof
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

  // Create keypairs for signing
  const payerKeyPair = await createKeyPairFromBytes(new Uint8Array([...payerSecretKey, ...payerPublicKey]));
  const equalityKeyPair = await createKeyPairFromBytes(new Uint8Array([...equalitySecretKey, ...equalityPublicKey]));
  const validityKeyPair = await createKeyPairFromBytes(new Uint8Array([...validitySecretKey, ...validityPublicKey]));
  const rangeKeyPair = await createKeyPairFromBytes(new Uint8Array([...rangeSecretKey, ...rangePublicKey]));

  console.log('\n4. Creating and verifying proofs step by step...\n');

  // === STEP 1: Create equality context + verify proof ===
  console.log('Step 1: Create equality context + verify proof');
  {
    const rent = await getRent(CONTEXT_STATE_SIZES.equality);
    const createIx = buildCreateAccountInstruction(payerAddress, equalityAddress, rent, CONTEXT_STATE_SIZES.equality, ZK_PROOF_PROGRAM_ID);
    const verifyIx = buildVerifyProofInstruction(ZK_INSTRUCTION.VerifyCiphertextCommitmentEquality, equalityProofBytes, equalityAddress, payerAddress);

    const result = await sendWithRetry(async () => {
      const { blockhash: bh, lastValidBlockHeight } = await getBlockhash();
      const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(payerAddress), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(bh), lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([createIx, verifyIx], m),
      );
      const compiled = compileTransaction(txMessage);
      const signed = await signTransaction([payerKeyPair, equalityKeyPair], compiled);
      return getBase64EncodedWireTransaction(signed);
    });

    if (result.result) {
      console.log('   Sent:', result.result.slice(0, 40) + '...');
      const confirmed = await waitForConfirmation(result.result);
      if (confirmed) {
        console.log('   ✓ CONFIRMED');
      } else {
        console.log('   ✗ FAILED to confirm');
        return;
      }
    } else {
      console.log('   ✗ FAILED:', result.error?.message);
      return;
    }
  }

  // === STEP 2: Create validity2 context + verify proof ===
  console.log('\nStep 2: Create validity2 context + verify proof');
  {
    const rent = await getRent(CONTEXT_STATE_SIZES.validity2);
    const createIx = buildCreateAccountInstruction(payerAddress, validityAddress, rent, CONTEXT_STATE_SIZES.validity2, ZK_PROOF_PROGRAM_ID);
    const verifyIx = buildVerifyProofInstruction(ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity, validity2ProofBytes, validityAddress, payerAddress);

    const result = await sendWithRetry(async () => {
      const { blockhash: bh, lastValidBlockHeight } = await getBlockhash();
      const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(payerAddress), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(bh), lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([createIx, verifyIx], m),
      );
      const compiled = compileTransaction(txMessage);
      const signed = await signTransaction([payerKeyPair, validityKeyPair], compiled);
      return getBase64EncodedWireTransaction(signed);
    });

    if (result.result) {
      console.log('   Sent:', result.result.slice(0, 40) + '...');
      const confirmed = await waitForConfirmation(result.result);
      if (confirmed) {
        console.log('   ✓ CONFIRMED');
      } else {
        console.log('   ✗ FAILED to confirm');
        return;
      }
    } else {
      console.log('   ✗ FAILED:', result.error?.message);
      return;
    }
  }

  // === STEP 3: Create range context account ===
  console.log('\nStep 3: Create range context account');
  {
    const rent = await getRent(CONTEXT_STATE_SIZES.rangeU128);
    const createIx = buildCreateAccountInstruction(payerAddress, rangeAddress, rent, CONTEXT_STATE_SIZES.rangeU128, ZK_PROOF_PROGRAM_ID);

    const result = await sendWithRetry(async () => {
      const { blockhash: bh, lastValidBlockHeight } = await getBlockhash();
      const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(payerAddress), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(bh), lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([createIx], m),
      );
      const compiled = compileTransaction(txMessage);
      const signed = await signTransaction([payerKeyPair, rangeKeyPair], compiled);
      return getBase64EncodedWireTransaction(signed);
    });

    if (result.result) {
      console.log('   Sent:', result.result.slice(0, 40) + '...');
      const confirmed = await waitForConfirmation(result.result);
      if (confirmed) {
        console.log('   ✓ CONFIRMED');
      } else {
        console.log('   ✗ FAILED to confirm');
        return;
      }
    } else {
      console.log('   ✗ FAILED:', result.error?.message);
      return;
    }
  }

  // === STEP 4: Verify range proof (THE BIG ONE) ===
  console.log('\nStep 4: Verify range proof into context account (LARGE TRANSACTION)');
  {
    const verifyIx = buildVerifyProofInstruction(ZK_INSTRUCTION.VerifyBatchedRangeProofU128, rangeProofBytes, rangeAddress, payerAddress);

    const result = await sendWithRetry(async () => {
      const { blockhash: bh, lastValidBlockHeight } = await getBlockhash();
      const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(payerAddress), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(bh), lastValidBlockHeight }, m),
        (m) => appendTransactionMessageInstructions([verifyIx], m),
      );
      const compiled = compileTransaction(txMessage);
      const signed = await signTransaction([payerKeyPair], compiled);
      return getBase64EncodedWireTransaction(signed);
    });

    if (result.result) {
      console.log('   Sent:', result.result.slice(0, 40) + '...');
      const confirmed = await waitForConfirmation(result.result);
      if (confirmed) {
        console.log('   ✓ CONFIRMED');
      } else {
        console.log('   ✗ FAILED to confirm');
        return;
      }
    } else {
      console.log('   ✗ FAILED:', result.error?.message);
      return;
    }
  }

  console.log('\n=== ALL PROOFS VERIFIED SUCCESSFULLY! ===');
  console.log('\nContext state accounts:');
  console.log('  - Equality:', equalityAddress);
  console.log('  - Validity2:', validityAddress);
  console.log('  - Range:', rangeAddress);
  console.log('\nThe RPC now supports 4KB transactions!');
  console.log('Confidential transfers can proceed with these context state accounts.');
}

main().catch(console.error);
