/**
 * Signature -> ElGamal / AES key bytes, compatible with zk-sdk 0.4.
 *
 * Shared by the app and the Node scripts so every place that derives a
 * user's confidential-transfer keys produces the same bytes. Load the
 * results with `ElGamalSecretKey.fromBytes` and `AeKey.fromBytes`.
 */

import { sha3_512 } from '@noble/hashes/sha3.js';

// Ristretto255 / Ed25519 scalar field order.
const SCALAR_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  return bytes.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

function bigIntToLittleEndian32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Reproduces zk-sdk 0.4's `fromSignature` derivation so keys stay identical
 * across the 0.5 upgrade (0.5 dropped the per-key `fromSignature` and changed
 * `fromSeed`; deriving differently would strand existing encrypted balances):
 * seed = SHA3-512(signature); h = SHA3-512(seed); the ElGamal secret is h
 * reduced mod the scalar order and the AES key is h's first 16 bytes.
 */
export function legacyKeyBytesFromSignature(signature: Uint8Array): {
  elgamalSecret: Uint8Array;
  aesKey: Uint8Array;
} {
  const hash = sha3_512(sha3_512(signature));
  return {
    elgamalSecret: bigIntToLittleEndian32(littleEndianToBigInt(hash) % SCALAR_ORDER),
    aesKey: hash.slice(0, 16),
  };
}
