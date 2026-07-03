/**
 * STEP 04 — The deep-dive: where the encryption keys come from, and what
 *           "configuring an account" actually put on-chain.
 *
 * You just watched a transfer FAIL against an unconfigured account (step 03),
 * and both Alice's and Bob's accounts got configured "quietly" along the way
 * (Alice in step 02, Bob in step 03). This step unpacks what those configure
 * transactions did — without sending anything new.
 *
 * WHAT THIS TEACHES
 *   1. Encryption keys are DERIVED, not stored. Each owner signs two short,
 *      human-readable messages; the 64-byte Ed25519 signatures seed an
 *      ElGamal keypair (for the on-chain encrypted balances) and an AES key
 *      (for the owner's fast-to-decrypt balance cache). Sign the same text
 *      again — in this script, in the web app, on another machine — and you
 *      get the same keys. Nothing secret is ever written down. We PROVE it
 *      here: re-derive Alice's and Bob's keys from scratch and match them
 *      against what steps 02/03 published on-chain.
 *   2. Configuring an account publishes the owner's ElGamal PUBLIC key into
 *      the token account on-chain. That is what senders encrypt to — and it
 *      is exactly why the step 03 transfer to unconfigured Bob had nothing
 *      to encrypt to and failed.
 *   3. Configuration itself needs a ZK proof (pubkey validity) proving the
 *      ElGamal pubkey is well-formed — that proof ran inside the configure
 *      transactions you already watched in steps 02 and 03.
 *
 * WHAT TO POINT AT
 *   The two signed message strings printed below (readable text — this is the
 *   same thing Phantom shows in the web app), and the side-by-side lines:
 *   the locally RE-DERIVED pubkey versus the pubkey stored ON-CHAIN. They
 *   match, for both owners, with no new transaction — determinism on display.
 *
 * RUN
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/04-configure-account.ts
 */
import { type Address, address, getBase58Decoder } from '@solana/kit';
import { fetchToken } from '@solana-program/token-2022';

import {
  type OwnerState,
  deriveCtKeys,
  explorerAddress,
  getCtExtension,
  requireState,
  rpc,
  signerFromPrivateKeyString,
} from './helpers.ts';

async function verifyOwner(owner: OwnerState, mint: Address, configuredIn: string) {
  console.log(`\n${owner.name} (${owner.address})`);
  console.log(`  token account: ${owner.tokenAccount} (configured in ${configuredIn})`);

  // Re-derive the keys from nothing but the wallet + mint. The wallet signs
  // the SAME two readable messages it signed back then — same signatures,
  // same keys. Nothing was stored anywhere in between.
  console.log('  re-deriving keys by signing the same two messages again:');
  console.log(`    "ElGamalSecretKey:${owner.address}:${mint}"`);
  console.log(`    "AeKey:${owner.address}:${mint}"`);
  const signer = await signerFromPrivateKeyString(owner.secretBase58);
  const keys = await deriveCtKeys(signer, mint);
  const derivedPubkey = getBase58Decoder().decode(keys.elgamalKeypair.pubkey().toBytes());

  // Fetch what the configure transaction actually published on-chain.
  const token = await fetchToken(rpc, address(owner.tokenAccount), { commitment: 'confirmed' });
  const onChainPubkey = getCtExtension(token.data).elgamalPubkey;

  console.log(`  re-derived ElGamal pubkey (local, just now): ${derivedPubkey}`);
  console.log(`  stored ElGamal pubkey (on-chain):            ${onChainPubkey}`);
  if (derivedPubkey !== String(onChainPubkey)) {
    throw new Error(`${owner.name}: derived pubkey does not match the on-chain pubkey!`);
  }
  console.log('  MATCH — the key on-chain is a pure function of (wallet, mint).');
  console.log(`  ${explorerAddress(owner.tokenAccount)}`);
}

async function main() {
  console.log('STEP 04 — account configuration, unpacked (devnet)\n');

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const alice = requireState('alice', '02-deposit-and-apply.ts');
  const bob = requireState('bob', '03-confidential-transfer.ts');
  console.log(`Mint: ${mint}`);
  console.log('\nNo new transactions in this step — the actual configure transactions');
  console.log("already ran: Alice's in step 02, Bob's in step 03. Here we re-derive");
  console.log('both owners\' keys from scratch and check them against the chain.');

  await verifyOwner(alice, mint, 'step 02');
  await verifyOwner(bob, mint, 'step 03');

  console.log('\nBoth match. This is the whole configuration story:');
  console.log('  - sign two readable messages -> deterministic ElGamal + AES keys');
  console.log('  - ConfigureAccount publishes the ElGamal PUBLIC key on the token account');
  console.log('    (guarded by a ZK pubkey-validity proof, bundled into that transaction)');
  console.log('  - from then on, anyone can encrypt transfers TO you by reading that key');
  console.log('\nAnd it is why step 03 failed at first: no configure, no pubkey on the');
  console.log('account, nothing to encrypt to. Step 05: Bob decrypts what he received.');
}

main().catch(err => {
  console.error('\nSTEP 04 FAILED:', err);
  process.exit(1);
});
