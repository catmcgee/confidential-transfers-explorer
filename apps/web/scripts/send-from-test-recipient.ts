/**
 * Sends a confidential transfer FROM the test recipient wallet
 * (scripts/test-recipient.json) to a recipient wallet's pending balance.
 *
 * Usage: SOLANA_RPC_URL=<rpc> NODE_OPTIONS=--experimental-wasm-modules \
 *        npx tsx apps/web/scripts/send-from-test-recipient.ts <recipientWallet> [uiAmount]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  address,
  createSignableMessage,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  createTransactionPlanner,
  createTransactionPlanExecutor,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
  type Signature,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
} from '@solana-program/token-2022';
import { getConfidentialTransferInstructionPlan } from '@solana-program/token-2022/confidential';
import { AeKey, ElGamalKeypair } from '@solana/zk-sdk/bundler';

const HERE = dirname(fileURLToPath(import.meta.url));
const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function readEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const content = readFileSync(resolve(HERE, '../.env'), 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) return m[2];
  }
  return undefined;
}

async function confirm(signature: Signature): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const s = value[0];
    if (s?.err) throw new Error(`tx failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await sleep(1500);
  }
  throw new Error(`timeout confirming ${signature}`);
}

async function main() {
  const recipientWallet = address(process.argv[2]);
  const uiAmount = BigInt(process.argv[3] ?? '5');
  const amount = uiAmount * 10n ** 9n;

  const info = JSON.parse(readFileSync(resolve(HERE, 'test-recipient.json'), 'utf8'));
  const sender = await createKeyPairSignerFromPrivateKeyBytes(
    new Uint8Array(getBase58Encoder().encode(info.privateKeyBase58)),
  );
  const faucetRaw = readEnvVar('FAUCET_PRIVATE_KEY')!;
  const payer: KeyPairSigner = await createKeyPairSignerFromBytes(
    new Uint8Array(getBase58Encoder().encode(faucetRaw)),
  );

  const signText = async (text: string) => {
    const [d] = await sender.signMessages([createSignableMessage(new TextEncoder().encode(text))]);
    return new Uint8Array(d[sender.address]);
  };
  const elgamalKeypair = ElGamalKeypair.fromSignature(
    await signText(`ElGamalSecretKey:${sender.address}:${info.mint}`),
  );
  const aesKey = AeKey.fromSignature(await signText(`AeKey:${sender.address}:${info.mint}`));

  const mint = address(info.mint);
  const sourceToken = address(info.tokenAccount);
  const [destinationToken] = await findAssociatedTokenPda({
    owner: recipientWallet,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });

  const [sourceAccount, destAccount] = await Promise.all([
    fetchToken(rpc, sourceToken, { commitment: 'confirmed' }),
    fetchToken(rpc, destinationToken, { commitment: 'confirmed' }),
  ]);

  console.log(`Sending ${uiAmount} tokens confidentially`);
  console.log(`  from ${sender.address} (${sourceToken})`);
  console.log(`  to   ${recipientWallet} (${destinationToken})`);

  const plan = await getConfidentialTransferInstructionPlan({
    sourceToken,
    mint,
    destinationToken,
    sourceTokenAccount: sourceAccount.data,
    destinationTokenAccount: destAccount.data,
    authority: sender,
    amount,
    sourceElgamalKeypair: elgamalKeypair,
    aesKey,
    proofMode: 'context-state',
    payer,
    rpc,
  });

  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(payer, m)),
  });
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_ctx, message) => {
      const { value: blockhash } = await rpc.getLatestBlockhash().send();
      const tx = await signTransactionMessageWithSigners(
        setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
      );
      const sig = getSignatureFromTransaction(tx);
      await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
      console.log(`  sent https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await confirm(sig);
      await sleep(500);
      return tx;
    },
  });
  await executor(await planner(plan));
  console.log(`\nDone — ${uiAmount} tokens are now in ${recipientWallet}'s PENDING balance.`);
}

main().catch(e => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
