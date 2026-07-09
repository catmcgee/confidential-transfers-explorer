/**
 * Local browser wallet: a keypair generated on first visit and kept in
 * localStorage so the explorer works without a wallet extension. The kit
 * `KeyPairSigner` it produces signs messages (ElGamal/AES key derivation)
 * and transactions without any prompts.
 */

import bs58 from 'bs58';
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';

const STORAGE_KEY = 'ct-explorer:local-wallet-seed';

function generateSeed(): Uint8Array {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  localStorage.setItem(STORAGE_KEY, bs58.encode(seed));
  return seed;
}

/** Load the stored local wallet, creating one on first visit. */
export async function loadOrCreateLocalWallet(): Promise<KeyPairSigner> {
  let seed: Uint8Array | null = null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const decoded = bs58.decode(stored);
      if (decoded.length === 32) seed = decoded;
    } catch {
      // Corrupt value: fall through and regenerate
    }
  }
  return createKeyPairSignerFromPrivateKeyBytes(seed ?? generateSeed());
}

/** Throw away the stored key and generate a fresh one. */
export async function createFreshLocalWallet(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(generateSeed());
}

/**
 * The full 64-byte secret key (seed + public key) in base58 — the format
 * wallets like Phantom accept for import, so the key can be taken elsewhere.
 */
export function exportLocalWalletSecretKey(walletAddress: string): string | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  const seed = bs58.decode(stored);
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(getAddressEncoder().encode(address(walletAddress)), 32);
  return bs58.encode(secretKey);
}
