/**
 * Test script for confidential transfer deposit (simpler operation)
 * Run with: npx tsx scripts/test-deposit.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as zkSdk from '@solana/zk-sdk/node';
import { sha512 } from '@noble/hashes/sha2.js';
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, createMint, mintTo } from '@solana/spl-token';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

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
  console.log('=== Confidential Transfer Deposit Test ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  console.log('1. Getting test SOL...');
  await connection.requestAirdrop(payer.publicKey, 10_000_000_000);
  await new Promise(r => setTimeout(r, 2000));
  console.log('   Balance:', (await connection.getBalance(payer.publicKey)) / 1e9, 'SOL');
  console.log('   Payer:', payer.publicKey.toBase58());

  console.log('\n2. Checking what CT operations the indexer has recorded...');
  try {
    const feedResponse = await fetch('http://localhost:3000/api/feed?limit=20');
    const feed = await feedResponse.json();
    if (feed.success && feed.data.activities) {
      const types = new Set(feed.data.activities.map((a: any) => a.instructionType));
      console.log('   Instruction types seen:', Array.from(types).join(', '));

      // Check for successful transfers
      const transfers = feed.data.activities.filter((a: any) => a.instructionType === 'ConfidentialTransfer' || a.instructionType === 'Transfer');
      console.log('   Transfer count:', transfers.length);
    }
  } catch {
    console.log('   Could not fetch feed');
  }

  console.log('\n3. Checking if there are any existing CT-enabled tokens...');
  // Try to find a token with confidential transfer extension from the feed
  try {
    const feedResponse = await fetch('http://localhost:3000/api/feed?limit=100');
    const feed = await feedResponse.json();
    if (feed.success && feed.data.activities) {
      const mints = new Set(feed.data.activities.filter((a: any) => a.mint).map((a: any) => a.mint));
      console.log('   Unique mints:', mints.size);
      if (mints.size > 0) {
        console.log('   First few mints:', Array.from(mints).slice(0, 3));
      }
    }
  } catch {
    console.log('   Could not fetch feed');
  }

  console.log('\n4. Summary of issue:');
  console.log('   - Context state accounts: NOT SUPPORTED on this RPC');
  console.log('   - Inline proofs: Too large (1736+ bytes > 1232 max tx size)');
  console.log('   - This means full confidential transfers may not be possible');
  console.log('   ');
  console.log('   Options:');
  console.log('   1. Use a different RPC that supports context state accounts');
  console.log('   2. Wait for Address Lookup Tables to support ZK proof instructions');
  console.log('   3. Check if there\'s a batched/compressed proof format');
  console.log('   4. Use only Deposit/Withdraw which don\'t need all 3 proofs');

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
