import { readFileSync } from 'node:fs';
import {
  address, createSignableMessage, createSolanaRpc,
  createKeyPairSignerFromPrivateKeyBytes, getBase58Encoder,
} from '@solana/kit';
import { fetchToken } from '@solana-program/token-2022';
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

}
main();
