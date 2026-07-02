/**
 * STEP 05 — Bob decrypts what he received; everyone else sees ciphertext.
 *
 * WHAT THIS TEACHES
 *   Two different decryption paths, on purpose:
 *     - PENDING is ElGamal-encrypted (so senders can add to it without Bob's
 *       help). ElGamal decryption is a brute-force discrete-log search, only
 *       feasible for small numbers — which is why pending is stored as TWO
 *       ciphertexts: the low 16 bits and the high bits (total = lo + (hi<<16)).
 *     - AVAILABLE has an AES-encrypted companion ("decryptable available
 *       balance") that only Bob can write and only Bob can read — it decrypts
 *       instantly. It exists precisely so the owner never needs the slow
 *       ElGamal path for their own running balance.
 *
 *   And the punchline of the whole workshop: we print the RAW bytes an
 *   outsider sees on-chain. Base64 noise. The explorer, your RPC provider,
 *   and every validator see exactly this — only the key holder sees numbers.
 *
 * WHAT TO POINT AT
 *   The "what an outsider sees" block (ciphertext), then the decrypted
 *   amounts right below it. Same account, same bytes — the only difference
 *   is holding the key. In the web app this is the "encrypted" badge vs the
 *   unlocked balance after signing.
 *
 * RUN
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/05-decrypt.ts
 */
import { address } from '@solana/kit';
import { fetchToken } from '@solana-program/token-2022';
import { getApplyConfidentialPendingBalanceInstructionFromToken } from '@solana-program/token-2022/confidential';

import {
  type CtAccountState,
  createTools,
  deriveCtKeys,
  decryptAvailable,
  decryptPending,
  executeInstructions,
  explorerAddress,
  getCtExtension,
  loadPayer,
  requireState,
  rpc,
  signerFromPrivateKeyString,
  toBase64,
  ui,
} from './helpers.ts';

function printOutsiderView(ct: CtAccountState) {
  console.log('  pending balance (lo):          ' + toBase64(ct.pendingBalanceLow));
  console.log('  pending balance (hi):          ' + toBase64(ct.pendingBalanceHigh));
  console.log('  available balance (ElGamal):   ' + toBase64(ct.availableBalance));
  console.log('  decryptable available (AES):   ' + toBase64(ct.decryptableAvailableBalance));
}

async function main() {
  console.log('STEP 05 — Bob decrypts his balances (devnet)\n');

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const bob = requireState('bob', '02-configure-account.ts');
  const payer = await loadPayer();
  const tools = createTools(payer);

  console.log(`Bob's token account: ${explorerAddress(bob.tokenAccount)}\n`);

  // --- What EVERYONE sees (no keys needed — this is public account data) ---
  let token = await fetchToken(rpc, address(bob.tokenAccount), { commitment: 'confirmed' });
  let ct = getCtExtension(token.data);
  console.log('What an OUTSIDER sees on-chain (raw ciphertexts, base64):');
  printOutsiderView(ct);
  console.log('That is all the explorer, the RPC, and the validators ever get.\n');

  // --- What BOB sees: re-derive his keys by signing the same text ----------
  const bobSigner = await signerFromPrivateKeyString(bob.secretBase58);
  const keys = await deriveCtKeys(bobSigner, mint);
  console.log('Bob re-derives his keys (same signed messages as step 02) and decrypts:');

  // Pending: ElGamal lo/hi. This is the slow discrete-log path — the reason
  // the protocol splits pending into 16-bit chunks in the first place.
  const received = decryptPending(ct, keys.elgamalSecretKey);
  console.log(`\n  Bob's PENDING balance decrypts to: ${ui(received)} tokens`);
  console.log('  (that is what Alice sent in step 04 — nobody else can compute this)');

  // --- Apply pending so the credit becomes spendable ------------------------
  console.log('\nApplying the pending balance (pending -> available):');
  await executeInstructions(tools, [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: address(bob.tokenAccount),
      tokenAccount: token.data,
      authority: bobSigner,
      elgamalSecretKey: keys.elgamalSecretKey,
      aesKey: keys.aesKey,
    }),
  ]);

  // Available: instant AES decryption of Bob's own balance cache.
  token = await fetchToken(rpc, address(bob.tokenAccount), { commitment: 'confirmed' });
  ct = getCtExtension(token.data);
  const available = decryptAvailable(ct, keys.aesKey);
  console.log(`\n  Bob's AVAILABLE balance decrypts to: ${ui(available)} tokens (spendable)`);

  console.log('\nAnd the outsider view of the SAME account, after all of that:');
  printOutsiderView(ct);
  console.log('\nStill ciphertext. Only the key holder ever sees numbers — the explorer');
  console.log('shows "encrypted" to everyone else. That is confidential transfers.');
}

main().catch(err => {
  console.error('\nSTEP 05 FAILED:', err);
  process.exit(1);
});
