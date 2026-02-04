/**
 * Test different ways to initialize context state accounts
 * Run with: npx tsx scripts/test-context-init.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

// Discriminators
const ZK_INSTRUCTION = {
  CloseContextState: 0,
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
  console.log('=== Context State Initialization Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Balance:', (await connection.getBalance(payer.publicKey)) / 1e9, 'SOL');

  // Create ElGamal keypairs for proof generation
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
  const recipientPubkey = zkSdk.ElGamalKeypair.fromSecretKey(recipientElgamalSecretKey).pubkey();

  // Create a validity proof
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

  console.log('\n2. Proof sizes:');
  console.log('   Proof data:', validityProofBytes.length, 'bytes');
  console.log('   Context data:', validityContextBytes.length, 'bytes');

  // The working context state accounts were 369 and 288 bytes
  // Let's try sizes close to those
  const sizesToTry = [
    validityContextBytes.length,  // Exact context size
    validityContextBytes.length + 32 + 1,  // Context + pubkey + discriminator
    validityContextBytes.length + 64,  // Context + some header
    288,  // Size of one working account
    369,  // Size of other working account
    320,  // Some round number
    400,  // Larger
  ];

  console.log('\n3. Testing different account sizes and formats...\n');

  for (const size of sizesToTry) {
    const contextStateKeypair = Keypair.generate();
    const rentExempt = await connection.getMinimumBalanceForRentExemption(size);

    // Create account
    const { blockhash: createBlockhash } = await connection.getLatestBlockhash();
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: contextStateKeypair.publicKey,
      lamports: rentExempt,
      space: size,
      programId: ZK_PROOF_PROGRAM_ID,
    });

    const createMsg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: createBlockhash,
      instructions: [createAccountIx],
    }).compileToV0Message();

    const createTx = new VersionedTransaction(createMsg);
    createTx.sign([payer, contextStateKeypair]);

    try {
      await connection.sendTransaction(createTx, { skipPreflight: true });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.log(`Size ${size}: Failed to create account - ${e.message?.slice(0, 50)}`);
      continue;
    }

    // Try with proof_instruction_offset format
    // The instruction data might need: discriminator + proof_instruction_offset + proof_data
    // Or: discriminator + proof_data_with_context_flag

    // Format A: Just discriminator + proof (what we tried before)
    const formatA = new Uint8Array(1 + validityProofBytes.length);
    formatA[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    formatA.set(validityProofBytes, 1);

    // Format B: discriminator + some_flag + proof
    const formatB = new Uint8Array(2 + validityProofBytes.length);
    formatB[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    formatB[1] = 1; // Some flag indicating context state mode
    formatB.set(validityProofBytes, 2);

    // Format C: discriminator + proof_context_offset(1 byte signed) + proof
    const formatC = new Uint8Array(2 + validityProofBytes.length);
    formatC[0] = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
    formatC[1] = 0; // 0 could mean "use account 0 for context"
    formatC.set(validityProofBytes, 2);

    const formats = [
      { name: 'A (disc+proof)', data: formatA },
      { name: 'B (disc+flag+proof)', data: formatB },
      { name: 'C (disc+offset+proof)', data: formatC },
    ];

    for (const { name, data } of formats) {
      const verifyIx = new TransactionInstruction({
        programId: ZK_PROOF_PROGRAM_ID,
        keys: [
          { pubkey: contextStateKeypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(data),
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
        console.log(`Size ${size}, Format ${name}: ✓ SUCCESS - ${sig.slice(0, 20)}...`);

        // If success, check the account data
        await new Promise(r => setTimeout(r, 1000));
        const accountInfo = await connection.getAccountInfo(contextStateKeypair.publicKey);
        if (accountInfo) {
          console.log(`  Account data length after verify: ${accountInfo.data.length}`);
        }
        break; // Don't try other formats for this size
      } catch (err: any) {
        const errorMsg = err.logs?.find((l: string) => l.includes('failed:') || l.includes('invalid')) || err.message?.slice(0, 50);
        // console.log(`Size ${size}, Format ${name}: ✗ ${errorMsg}`);
      }
    }
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
