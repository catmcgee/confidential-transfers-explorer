/**
 * Decrypts the test recipient's balances (see create-test-recipient.ts).
 * Pass APPLY=1 to also apply the pending balance into available.
 *
 * Run: SOLANA_RPC_URL=<rpc> NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/check-test-recipient.ts
 */
import { readFileSync } from 'node:fs';
import {
  address, createSignableMessage, createSolanaRpc,
  createKeyPairSignerFromPrivateKeyBytes, createTransactionMessage,
  getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction,
  pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, appendTransactionMessageInstructions,
  type Signature,
} from '@solana/kit';
import { fetchToken } from '@solana-program/token-2022';
import { getApplyConfidentialPendingBalanceInstructionFromToken } from '@solana-program/token-2022/confidential';
import { AeCiphertext, AeKey, ElGamalCiphertext, ElGamalKeypair } from '@solana/zk-sdk/bundler';

async function main() {
  const info = JSON.parse(readFileSync('/Users/catmcgee/Documents/work/conf-transfers-explorer/apps/web/scripts/test-recipient.json', 'utf8'));
  const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(getBase58Encoder().encode(info.privateKeyBase58)));

  const signText = async (text: string) => {
    const [d] = await signer.signMessages([createSignableMessage(new TextEncoder().encode(text))]);
    return new Uint8Array(d[signer.address]);
  };
  const elgamal = ElGamalKeypair.fromSignature(await signText(`ElGamalSecretKey:${signer.address}:${info.mint}`));
  const aes = AeKey.fromSignature(await signText(`AeKey:${signer.address}:${info.mint}`));

  const account = await fetchToken(rpc, address(info.tokenAccount), { commitment: 'confirmed' });
  const exts = account.data.extensions.__option === 'Some' ? account.data.extensions.value : [];
  const ct = exts.find((e: any) => e.__kind === 'ConfidentialTransferAccount') as any;

  const pendingLo = elgamal.secret().decrypt(ElGamalCiphertext.fromBytes(new Uint8Array(ct.pendingBalanceLow))!);
  const pendingHi = elgamal.secret().decrypt(ElGamalCiphertext.fromBytes(new Uint8Array(ct.pendingBalanceHigh))!);
  const pending = pendingLo + (pendingHi << 16n);
  const available = aes.decrypt(AeCiphertext.fromBytes(new Uint8Array(ct.decryptableAvailableBalance))!);

  console.log('public tokens:      ', account.data.amount / 10n**9n);
  console.log('pending (incoming): ', Number(pending) / 1e9);
  console.log('available:          ', Number(available) / 1e9);
  console.log('pendingBalanceCreditCounter:', ct.pendingBalanceCreditCounter);

  if (process.env.APPLY === '1' && pending > 0n) {
    console.log('\nApplying pending balance...');
    const applyIx = getApplyConfidentialPendingBalanceInstructionFromToken({
      token: address(info.tokenAccount),
      tokenAccount: account.data,
      authority: signer,
      elgamalSecretKey: elgamal.secret(),
      aesKey: aes,
    });
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(signer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        m => appendTransactionMessageInstructions([applyIx], m),
      ),
    );
    const signature = getSignatureFromTransaction(tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
    console.log(`sent https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    for (let i = 0; i < 40; i++) {
      const { value } = await rpc.getSignatureStatuses([signature as Signature]).send();
      const status = value[0];
      if (status?.err) throw new Error(`apply failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
      await new Promise(r => setTimeout(r, 1500));
    }

    const after = await fetchToken(rpc, address(info.tokenAccount), { commitment: 'confirmed' });
    const afterExts = after.data.extensions.__option === 'Some' ? after.data.extensions.value : [];
    const afterCt = afterExts.find((e: any) => e.__kind === 'ConfidentialTransferAccount') as any;
    const afterAvailable = aes.decrypt(AeCiphertext.fromBytes(new Uint8Array(afterCt.decryptableAvailableBalance))!);
    console.log('available after apply:', Number(afterAvailable) / 1e9);
  }
}
main();
