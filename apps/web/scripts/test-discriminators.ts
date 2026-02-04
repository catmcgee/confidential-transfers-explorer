/**
 * Test script to discover correct ZK proof program discriminators
 * Run with: npx tsx scripts/test-discriminators.ts
 */

import { Keypair, Connection, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from '@solana/web3.js';

const RPC_URL = 'https://zk-edge.surfnet.dev:8899';
const ZK_PROOF_PROGRAM_ID = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

async function main() {
  console.log('=== ZK Proof Discriminator Discovery ===\n');

  const connection = new Connection(RPC_URL, 'confirmed');
  const payer = Keypair.generate();

  // Request airdrop
  console.log('Requesting airdrop...');
  try {
    const sig = await connection.requestAirdrop(payer.publicKey, 1_000_000_000);
    await new Promise(r => setTimeout(r, 2000));
    console.log('Got airdrop\n');
  } catch (err) {
    console.error('Airdrop failed:', err);
    return;
  }

  // Test each discriminator 0-20 to see what the program interprets them as
  console.log('Testing discriminators 0-20...\n');

  for (let disc = 0; disc <= 20; disc++) {
    // Send minimal data to see what instruction it thinks this is
    const instructionData = new Uint8Array([disc, 0, 0, 0]); // discriminator + some padding

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
      // Use simulateTransaction to see the error without actually sending
      const result = await connection.simulateTransaction(transaction, { sigVerify: false });

      if (result.value.err) {
        const logs = result.value.logs || [];
        // Look for the instruction name in the logs
        for (const log of logs) {
          if (log.includes('Program ZkE1Gama1Proof') && !log.includes('invoke') && !log.includes('failed')) {
            console.log(`Discriminator ${disc}: ${log}`);
            break;
          }
        }
        if (!logs.some(l => l.includes('Program ZkE1Gama1Proof') && !l.includes('invoke') && !l.includes('failed'))) {
          // Check for unknown instruction
          if (logs.some(l => l.includes('unknown instruction'))) {
            console.log(`Discriminator ${disc}: unknown instruction`);
          } else {
            console.log(`Discriminator ${disc}: (check logs)`, logs.filter(l => !l.includes('invoke')).slice(0, 2));
          }
        }
      } else {
        console.log(`Discriminator ${disc}: Success (unexpected)`);
      }
    } catch (err: any) {
      console.log(`Discriminator ${disc}: Error - ${err.message?.slice(0, 50)}...`);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n=== Discovery Complete ===');
}

main().catch(console.error);
