/**
 * Confidential Transfer operations using TypeScript ZK SDK
 * This implementation uses @solana/zk-sdk for cryptographic operations
 * and @solana-program/zk-elgamal-proof for instruction building
 */

import {
  address,
  type Address,
  type Instruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  pipe,
} from '@solana/kit';
import { blockhash } from '@solana/rpc-types';
import {
  getConfigureConfidentialTransferAccountInstruction,
  getConfidentialDepositInstruction,
  getApplyConfidentialPendingBalanceInstruction,
} from '@solana-program/token-2022';
import { ed25519, ristretto255 } from '@noble/curves/ed25519.js';
import { sha3_512 } from '@noble/hashes/sha3.js';
import bs58 from 'bs58';

// We'll dynamically import the ZK SDK to handle WASM loading
let zkSdk: typeof import('@solana/zk-sdk/bundler') | null = null;

async function getZkSdk() {
  if (!zkSdk) {
    zkSdk = await import('@solana/zk-sdk/bundler');
  }
  return zkSdk;
}

// Instance types for ZK SDK classes (vs the class constructor types)
type ZkSdk = Awaited<ReturnType<typeof getZkSdk>>;
type ElGamalKeypairInstance = InstanceType<ZkSdk['ElGamalKeypair']>;
type AeKeyInstance = InstanceType<ZkSdk['AeKey']>;
type ElGamalSecretKeyInstance = InstanceType<ZkSdk['ElGamalSecretKey']>;

// Constants
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const SYSVAR_INSTRUCTIONS_ID = 'Sysvar1nstructions1111111111111111111111111' as Address;
const ZK_PROOF_PROGRAM_ID = 'ZkE1Gama1Proof11111111111111111111111111111' as Address;
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111' as Address;

// ZK Proof Program Instruction Discriminators
const ZK_INSTRUCTION = {
  CloseContextState: 0,
  VerifyZeroCiphertext: 1,
  VerifyCiphertextCiphertextEquality: 2,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyPubkeyValidity: 4,
  VerifyPercentageWithCap: 5,
  VerifyBatchedRangeProofU64: 6,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedRangeProofU256: 8,
  VerifyGroupedCiphertext2HandlesValidity: 9,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,
  VerifyGroupedCiphertext3HandlesValidity: 11,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,
} as const;

// Context State Account sizes (from constants.ts in zk-elgamal-proof)
const CONTEXT_STATE_META_SIZE = 33;
const CONTEXT_STATE_SIZES = {
  pubkeyValidity: CONTEXT_STATE_META_SIZE + 32, // 65
  equality: CONTEXT_STATE_META_SIZE + 128, // 161
  validity2: CONTEXT_STATE_META_SIZE + 256, // 289
  validity3: CONTEXT_STATE_META_SIZE + 352, // 385
  rangeU128: CONTEXT_STATE_META_SIZE + 264, // 297
} as const;

// Compute unit limits
const COMPUTE_UNITS = {
  equality: 150_000,
  validity: 300_000,
  transfer: 450_000,
} as const;

// =============================================================================
// Utility Functions
// =============================================================================

function decodeBase58(str: string): Uint8Array {
  return bs58.decode(str);
}

function encodeBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

function decodeBase64(str: string): Uint8Array {
  const binaryStr = atob(str);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function numberToLEBytes(num: bigint, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let remaining = num;
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// Ed25519/Ristretto255 scalar order
const SCALAR_ORDER = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

/**
 * Derives a valid ElGamal secret key scalar from signature bytes.
 * Matches Solana's Scalar::hash_from_bytes::<Sha512>: SHA-512 hash the input,
 * interpret the 64-byte result as a little-endian integer, reduce mod scalar order.
 */
async function hashToScalar(input: Uint8Array): Promise<Uint8Array> {
  const inputCopy = new Uint8Array(input);
  const hash = await crypto.subtle.digest('SHA-512', inputCopy.buffer as ArrayBuffer);
  const hashBytes = new Uint8Array(hash);
  const scalar = bytesToBigIntLE(hashBytes) % SCALAR_ORDER;
  return numberToLEBytes(scalar, 32);
}

// =============================================================================
// Key Derivation using ZK SDK
// =============================================================================

/**
 * Derives ElGamal keypair from wallet signature
 * Uses the same derivation as Solana's confidential transfers
 */
export async function deriveElGamalKeypair(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  tokenAccountAddress: string
): Promise<{
  keypair: ElGamalKeypairInstance;
  publicKeyBytes: Uint8Array;
  aeKey: AeKeyInstance;
}> {
  const zk = await getZkSdk();
  const accountBytes = decodeBase58(tokenAccountAddress);

  // ElGamal signature - derive secret key from signature
  const elgamalPrefix = new TextEncoder().encode('ElGamalSecretKey');
  const elgamalMessage = new Uint8Array(elgamalPrefix.length + accountBytes.length);
  elgamalMessage.set(elgamalPrefix);
  elgamalMessage.set(accountBytes, elgamalPrefix.length);
  const elgamalSignature = await signMessage(elgamalMessage);

  // Hash the FULL 64-byte signature with SHA-512 and reduce mod scalar order
  // This matches Solana's Scalar::hash_from_bytes::<Sha512>(signature.as_ref())
  const secretKeyBytes = await hashToScalar(elgamalSignature);

  // DEBUG: Log scalar bytes and round-trip
  const scalarHex = Array.from(secretKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log('DEBUG: scalar bytes (input to WASM):', scalarHex);
  console.log('DEBUG: expected Rust scalar:', 'ef58275be5f6b51dd0087f8df35a1bbab0cb982a73106e3e0a06ee3bec468001');

  const secretKey = zk.ElGamalSecretKey.fromBytes(secretKeyBytes);

  // DEBUG: Check round-trip
  const roundTripped = secretKey.toBytes();
  const roundTrippedHex = Array.from(roundTripped).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log('DEBUG: scalar bytes (round-trip from WASM):', roundTrippedHex);
  console.log('DEBUG: scalar round-trip match:', scalarHex === roundTrippedHex);

  const keypair = zk.ElGamalKeypair.fromSecretKey(secretKey);

  // DEBUG: Also create pubkey directly
  const directPubkey = zk.ElGamalPubkey.fromSecretKey(secretKey);
  const directPubkeyHex = Array.from(directPubkey.toBytes()).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log('DEBUG: pubkey from keypair:', Array.from(keypair.pubkey().toBytes()).map(b => b.toString(16).padStart(2, '0')).join(''));
  console.log('DEBUG: pubkey direct:', directPubkeyHex);
  console.log('DEBUG: expected Rust pubkey:', 'e8c7bbecd4a6bcb74e9d72c32a64c5f33e038f28790747171cf98edaaff6be6b');

  // AeKey signature - derive AE key from signature using SHA3-512 (double hash)
  // Matches Solana's AeKey::new_from_signer() which uses:
  //   1. seed = SHA3-512(full_signature)
  //   2. key = SHA3-512(seed)[0..16]
  const aeKeyPrefix = new TextEncoder().encode('AeKey');
  const aeKeyMessage = new Uint8Array(aeKeyPrefix.length + accountBytes.length);
  aeKeyMessage.set(aeKeyPrefix);
  aeKeyMessage.set(accountBytes, aeKeyPrefix.length);
  const aeKeySignature = await signMessage(aeKeyMessage);

  // Step 1: seed_from_signature - SHA3-512 hash of the full 64-byte signature
  const seed = sha3_512(aeKeySignature);
  // Step 2: from_seed - SHA3-512 hash of the seed, take first 16 bytes
  const aeKeyDerived = sha3_512(seed).slice(0, 16);
  const aeKey = zk.AeKey.fromBytes(aeKeyDerived);

  return {
    keypair,
    publicKeyBytes: keypair.pubkey().toBytes(),
    aeKey,
  };
}

/**
 * Fallback: generate ElGamal keypair from random bytes, stored in localStorage.
 * Used when wallet signMessage is broken (e.g. Backpack UserKeyring bug).
 */
export async function generateElGamalKeypairFallback(
  tokenAccountAddress: string
): Promise<{
  keypair: ElGamalKeypairInstance;
  publicKeyBytes: Uint8Array;
  aeKey: AeKeyInstance;
}> {
  const storageKey = `ct-keys-${tokenAccountAddress}`;
  const zk = await getZkSdk();

  // Check localStorage for existing keys
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const secretKeyBytes = new Uint8Array(parsed.elgamalSecret);
      const aeKeyBytes = new Uint8Array(parsed.aeKeyBytes);
      const secretKey = zk.ElGamalSecretKey.fromBytes(secretKeyBytes);
      const keypair = zk.ElGamalKeypair.fromSecretKey(secretKey);
      const aeKey = zk.AeKey.fromBytes(aeKeyBytes);
      console.log('Loaded ElGamal keys from localStorage for', tokenAccountAddress);
      return { keypair, publicKeyBytes: keypair.pubkey().toBytes(), aeKey };
    } catch (e) {
      console.warn('Failed to load stored keys, regenerating:', e);
    }
  }

  // Generate random keys
  console.log('Generating random ElGamal keypair (signMessage fallback)...');
  const randomBytes = crypto.getRandomValues(new Uint8Array(64));
  const secretKeyBytes = await hashToScalar(randomBytes);
  const secretKey = zk.ElGamalSecretKey.fromBytes(secretKeyBytes);
  const keypair = zk.ElGamalKeypair.fromSecretKey(secretKey);

  const aeRandomBytes = crypto.getRandomValues(new Uint8Array(64));
  const aeSeed = sha3_512(aeRandomBytes);
  const aeKeyDerived = sha3_512(aeSeed).slice(0, 16);
  const aeKey = zk.AeKey.fromBytes(aeKeyDerived);

  // Store in localStorage for future use
  localStorage.setItem(storageKey, JSON.stringify({
    elgamalSecret: Array.from(secretKeyBytes),
    aeKeyBytes: Array.from(aeKeyDerived),
  }));
  console.log('Stored random ElGamal keys in localStorage for', tokenAccountAddress);

  return { keypair, publicKeyBytes: keypair.pubkey().toBytes(), aeKey };
}

/**
 * Generate pubkey validity proof for configuring confidential transfer account
 */
export async function generatePubkeyValidityProof(
  keypair: ElGamalKeypairInstance
): Promise<Uint8Array> {
  const zk = await getZkSdk();
  const proofData = new zk.PubkeyValidityProofData(keypair);
  return proofData.toBytes();
}

/**
 * Encrypt a balance using the AE key
 */
export async function encryptBalance(
  aeKey: AeKeyInstance,
  amount: bigint
): Promise<Uint8Array> {
  const ciphertext = aeKey.encrypt(amount);
  return ciphertext.toBytes();
}

/**
 * Decrypt an AE ciphertext
 */
export async function decryptAeBalance(
  aeKey: AeKeyInstance,
  ciphertextBytes: Uint8Array
): Promise<bigint | null> {
  const zk = await getZkSdk();
  const ciphertext = zk.AeCiphertext.fromBytes(ciphertextBytes);
  if (!ciphertext) return null;
  const result = ciphertext.decrypt(aeKey);
  return result ?? null;
}

/**
 * Decrypt ElGamal ciphertext using secret key
 */
export async function decryptElGamalBalance(
  secretKey: ElGamalSecretKeyInstance,
  ciphertextBytes: Uint8Array
): Promise<bigint | null> {
  const zk = await getZkSdk();
  const ciphertext = zk.ElGamalCiphertext.fromBytes(ciphertextBytes);
  if (!ciphertext) return null;
  try {
    return secretKey.decrypt(ciphertext);
  } catch {
    return null;
  }
}

// =============================================================================
// Transfer Proof Generation
// =============================================================================

export interface TransferProofs {
  equalityProofData: Uint8Array;
  validityProofData: Uint8Array;
  rangeProofData: Uint8Array;
  ciphertextLo: Uint8Array;
  ciphertextHi: Uint8Array;
  auditorCiphertextLo: Uint8Array; // 64 bytes: auditor's individual ElGamal ciphertext for lo
  auditorCiphertextHi: Uint8Array; // 64 bytes: auditor's individual ElGamal ciphertext for hi
  newDecryptableBalance: Uint8Array;
  hasAuditor: boolean;
}

/**
 * Generate all proofs needed for a confidential transfer
 */
export async function generateTransferProofs(
  senderKeypair: ElGamalKeypairInstance,
  senderAeKey: AeKeyInstance,
  recipientPubkeyBytes: Uint8Array,
  amount: bigint,
  currentBalance: bigint,
  sourceAvailableBalanceCt: Uint8Array, // 64-byte ElGamal ciphertext from on-chain account
  auditorPubkeyBytes?: Uint8Array
): Promise<TransferProofs> {
  const zk = await getZkSdk();

  const hasAuditor = !!auditorPubkeyBytes;
  const newBalance = currentBalance - amount;

  // Split amount into lo (16 bits) and hi (32 bits)
  // On-chain TRANSFER_AMOUNT_LO_BITS = 16
  const amountLo = amount & ((1n << 16n) - 1n);
  const amountHi = amount >> 16n;

  // Get pubkeys
  const senderPubkey = senderKeypair.pubkey();
  const recipientPubkey = zk.ElGamalPubkey.fromBytes(recipientPubkeyBytes);

  // Create openings for the commitments
  const openingLo = new zk.PedersenOpening();
  const openingHi = new zk.PedersenOpening();

  // The on-chain Transfer processor ALWAYS expects 3-handle validity proofs
  // (BatchedGroupedCiphertext3HandlesValidity), even when the mint has no auditor.
  // When there's no auditor, use a zero ElGamal public key (identity element).
  const auditorPubkey = hasAuditor && auditorPubkeyBytes
    ? zk.ElGamalPubkey.fromBytes(auditorPubkeyBytes)
    : zk.ElGamalPubkey.fromBytes(new Uint8Array(32)); // zero/identity key

  // Always create 3-handle grouped ciphertexts (sender, recipient, auditor)
  const groupedCiphertextLo = zk.GroupedElGamalCiphertext3Handles.encryptWith(
    senderPubkey,
    recipientPubkey,
    auditorPubkey,
    amountLo,
    openingLo
  );
  const groupedCiphertextHi = zk.GroupedElGamalCiphertext3Handles.encryptWith(
    senderPubkey,
    recipientPubkey,
    auditorPubkey,
    amountHi,
    openingHi
  );

  const ciphertextLo = groupedCiphertextLo.toBytes();
  const ciphertextHi = groupedCiphertextHi.toBytes();

  // Always use 3-handle validity proof
  const validityProof = new zk.BatchedGroupedCiphertext3HandlesValidityProofData(
    senderPubkey,
    recipientPubkey,
    auditorPubkey,
    groupedCiphertextLo,
    groupedCiphertextHi,
    amountLo,
    amountHi,
    openingLo,
    openingHi
  );
  const validityProofData = validityProof.toBytes();

  // Derive the new balance ciphertext via homomorphic subtraction from on-chain state.
  //
  // On-chain verification checks:
  //   source_available_balance == new_balance_ct + amount_lo_source_ct + amount_hi_source_ct * 2^16
  //
  // So we must compute:
  //   new_balance_ct = source_available_balance - amount_lo_source_ct - amount_hi_source_ct * 2^16
  //
  // where amount_lo/hi_source_ct are the sender's individual ciphertexts extracted from
  // the grouped ciphertexts. Each individual ciphertext = [commitment(32)][handle_source(32)].

  // Extract sender's individual ciphertexts from grouped ciphertexts
  // GroupedElGamalCiphertext3Handles: [commitment(32)][handle1/source(32)][handle2/recipient(32)][handle3/auditor(32)]
  const senderCtLo = new Uint8Array(64);
  senderCtLo.set(ciphertextLo.slice(0, 32), 0);  // commitment
  senderCtLo.set(ciphertextLo.slice(32, 64), 32); // handle1 (sender)

  const senderCtHi = new Uint8Array(64);
  senderCtHi.set(ciphertextHi.slice(0, 32), 0);
  senderCtHi.set(ciphertextHi.slice(32, 64), 32);

  // Perform Ristretto point arithmetic on the ciphertext components
  // Each ElGamal ciphertext has: commitment (32-byte Ristretto point) + handle (32-byte Ristretto point)
  const RPoint = ristretto255.Point;
  const TWO_16 = 2n ** 16n;

  // Parse source (on-chain) ciphertext
  const srcCommitment = RPoint.fromBytes(sourceAvailableBalanceCt.slice(0, 32));
  const srcHandle = RPoint.fromBytes(sourceAvailableBalanceCt.slice(32, 64));

  // Parse sender Lo ciphertext
  const loCommitment = RPoint.fromBytes(senderCtLo.slice(0, 32));
  const loHandle = RPoint.fromBytes(senderCtLo.slice(32, 64));

  // Parse sender Hi ciphertext
  const hiCommitment = RPoint.fromBytes(senderCtHi.slice(0, 32));
  const hiHandle = RPoint.fromBytes(senderCtHi.slice(32, 64));

  // new_balance_ct = source - lo - hi * 2^16
  const newCtCommitment = srcCommitment.subtract(loCommitment).subtract(hiCommitment.multiply(TWO_16));
  const newCtHandle = srcHandle.subtract(loHandle).subtract(hiHandle.multiply(TWO_16));

  // Reconstruct the derived ciphertext bytes
  const newBalanceCtBytes = new Uint8Array(64);
  newBalanceCtBytes.set(newCtCommitment.toBytes(), 0);
  newBalanceCtBytes.set(newCtHandle.toBytes(), 32);

  const newBalanceCiphertext = zk.ElGamalCiphertext.fromBytes(newBalanceCtBytes);
  if (!newBalanceCiphertext) {
    throw new Error('Failed to construct new balance ciphertext from homomorphic derivation');
  }

  // Create commitment for new balance (for equality proof)
  const newBalanceOpening = new zk.PedersenOpening();
  const newBalanceCommitment = zk.PedersenCommitment.from(newBalance, newBalanceOpening);

  // Equality proof: proves the DERIVED ciphertext encrypts the same value as the commitment
  const equalityProof = new zk.CiphertextCommitmentEqualityProofData(
    senderKeypair,
    newBalanceCiphertext,
    newBalanceCommitment,
    newBalanceOpening,
    newBalance
  );
  const equalityProofData = equalityProof.toBytes();

  // Range proof: proves amounts are in valid ranges
  // Per reference implementation, entries are:
  //   1. newBalance commitment (64 bits) - SAME opening as equality proof (newBalanceOpening)
  //   2. amountLo commitment (16 bits) - extracted from grouped ciphertext, SAME opening as validity proof (openingLo)
  //   3. amountHi commitment (32 bits) - extracted from grouped ciphertext, SAME opening as validity proof (openingHi)
  //   4. padding commitment (16 bits) - value 0, fresh opening
  // Bit lengths: [64, 16, 32, 16] = 128 bits total

  // Extract Pedersen commitments from the grouped ciphertexts (first 32 bytes = commitment component)
  const commitmentAmountLo = zk.PedersenCommitment.fromBytes(ciphertextLo.slice(0, 32));
  const commitmentAmountHi = zk.PedersenCommitment.fromBytes(ciphertextHi.slice(0, 32));

  // Padding commitment: encrypts 0 with a fresh opening
  const paddingOpening = new zk.PedersenOpening();
  const paddingCommitment = zk.PedersenCommitment.from(0n, paddingOpening);

  const rangeProof = new zk.BatchedRangeProofU128Data(
    [newBalanceCommitment, commitmentAmountLo, commitmentAmountHi, paddingCommitment],
    new BigUint64Array([newBalance, amountLo, amountHi, 0n]),
    new Uint8Array([64, 16, 32, 16]), // bit lengths must sum to 128
    [newBalanceOpening, openingLo, openingHi, paddingOpening]
  );
  const rangeProofData = rangeProof.toBytes();

  // Encrypt new balance with AE key
  const newDecryptableBalance = senderAeKey.encrypt(newBalance).toBytes();

  // Extract auditor's individual ElGamal ciphertexts from 3-handle grouped ciphertexts.
  // GroupedElGamalCiphertext3Handles layout: [commitment(32)][handle1(32)][handle2(32)][handle3(32)]
  // Auditor's individual ciphertext: [commitment(32)][handle3(32)] = 64 bytes
  const auditorCiphertextLo = new Uint8Array(64);
  auditorCiphertextLo.set(ciphertextLo.slice(0, 32), 0);   // commitment
  auditorCiphertextLo.set(ciphertextLo.slice(96, 128), 32); // handle3 (auditor)
  const auditorCiphertextHi = new Uint8Array(64);
  auditorCiphertextHi.set(ciphertextHi.slice(0, 32), 0);
  auditorCiphertextHi.set(ciphertextHi.slice(96, 128), 32);

  return {
    equalityProofData,
    validityProofData,
    rangeProofData,
    ciphertextLo,
    ciphertextHi,
    auditorCiphertextLo,
    auditorCiphertextHi,
    newDecryptableBalance,
    hasAuditor,
  };
}

// =============================================================================
// Configure Confidential Transfer Account
// =============================================================================

export async function buildConfigureCtInstructions(
  tokenAccountAddress: string,
  mintAddress: string,
  ownerAddress: string,
  keypair: ElGamalKeypairInstance,
  aeKey: AeKeyInstance
): Promise<{
  reallocateInstruction: Instruction;
  proofInstruction: Instruction;
  configureInstruction: Instruction;
}> {
  // Generate pubkey validity proof
  const proofData = await generatePubkeyValidityProof(keypair);

  // Encrypt zero for decryptable balance
  const decryptableZeroBalance = aeKey.encrypt(0n).toBytes();

  // 1. Reallocate instruction
  // Token-2022 Reallocate packs extension types directly (no vec length prefix)
  // Format: [opcode(1 byte), ...extension_types(2 bytes each as u16 LE)]
  const reallocateData = new Uint8Array(1 + 2);
  reallocateData[0] = 29; // Reallocate
  reallocateData[1] = 5; reallocateData[2] = 0; // ExtensionType::ConfidentialTransferAccount = 5

  const reallocateInstruction: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: address(tokenAccountAddress), role: 1 }, // WRITABLE
      { address: address(ownerAddress), role: 3 }, // WRITABLE_SIGNER (payer)
      { address: SYSTEM_PROGRAM_ID, role: 0 }, // READONLY
      { address: address(ownerAddress), role: 2 }, // READONLY_SIGNER (owner/authority)
    ],
    data: reallocateData,
  };

  // 2. ZK proof instruction for pubkey validity
  const proofInstructionData = new Uint8Array(1 + proofData.length);
  proofInstructionData[0] = ZK_INSTRUCTION.VerifyPubkeyValidity;
  proofInstructionData.set(proofData, 1);

  const proofInstruction: Instruction = {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [],
    data: proofInstructionData,
  };

  // 3. Configure instruction using official SDK
  // Pass authority as just an Address - we'll fix the signer role below
  const configureInstruction = getConfigureConfidentialTransferAccountInstruction({
    token: address(tokenAccountAddress),
    mint: address(mintAddress),
    instructionsSysvarOrContextState: SYSVAR_INSTRUCTIONS_ID,
    authority: address(ownerAddress),
    decryptableZeroBalance: decryptableZeroBalance as never,
    maximumPendingBalanceCreditCounter: 65536n,
    proofInstructionOffset: 1, // proof comes AFTER configure
  });

  // Fix the configure instruction accounts:
  // 1. The SDK includes the Token-2022 program ID as an account (for CPI use),
  //    but we're calling it directly, so remove it to avoid shifting account indices.
  // 2. The SDK marks authority as READONLY when passed as Address, but the
  //    on-chain program requires it to be a signer.
  const ownerAddr = address(ownerAddress);
  const fixedConfigureAccounts = configureInstruction.accounts
    .filter((account: { address: Address; role: number }) => {
      // Remove the Token-2022 program ID from accounts list
      return String(account.address) !== String(TOKEN_2022_PROGRAM_ID);
    })
    .map((account: { address: Address; role: number }) => {
      // Upgrade authority to signer
      if (String(account.address) === String(ownerAddr)) {
        return { ...account, role: 2 }; // READONLY_SIGNER
      }
      return account;
    });
  const fixedConfigureInstruction = { ...configureInstruction, accounts: fixedConfigureAccounts } as Instruction;

  return { reallocateInstruction, proofInstruction, configureInstruction: fixedConfigureInstruction };
}

export function buildConfigureCtTransaction(
  reallocateInstruction: Instruction,
  configureInstruction: Instruction,
  proofInstruction: Instruction,
  recentBlockhash: string,
  lastValidBlockHeight: bigint,
  feePayer: string
): ReturnType<typeof compileTransaction> {
  const feePayerAddress = address(feePayer);

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions(
      [reallocateInstruction, configureInstruction, proofInstruction],
      m
    ),
  );

  return compileTransaction(transactionMessage);
}

export function serializeTransactionToBase64(
  compiledTransaction: ReturnType<typeof compileTransaction>
): string {
  return getBase64EncodedWireTransaction(compiledTransaction);
}

// =============================================================================
// Deposit - Move tokens from public to confidential balance
// =============================================================================

export function buildDepositInstruction(
  tokenAccountAddress: string,
  mintAddress: string,
  ownerAddress: string,
  amount: bigint,
  decimals: number
): Instruction {
  return getConfidentialDepositInstruction({
    token: address(tokenAccountAddress),
    mint: address(mintAddress),
    authority: address(ownerAddress),
    amount,
    decimals,
  });
}

export function buildDepositTransaction(
  depositInstruction: Instruction,
  recentBlockhash: string,
  lastValidBlockHeight: bigint,
  feePayer: string
): ReturnType<typeof compileTransaction> {
  const feePayerAddress = address(feePayer);

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([depositInstruction], m),
  );

  return compileTransaction(transactionMessage);
}

// =============================================================================
// Apply Pending Balance
// =============================================================================

export async function buildApplyPendingBalanceInstruction(
  tokenAccountAddress: string,
  ownerAddress: string,
  aeKey: AeKeyInstance,
  expectedNewAvailableBalance: bigint,
  expectedPendingBalanceCreditCounter: bigint
): Promise<Instruction> {
  const newDecryptableBalance = aeKey.encrypt(expectedNewAvailableBalance).toBytes();

  return getApplyConfidentialPendingBalanceInstruction({
    token: address(tokenAccountAddress),
    authority: address(ownerAddress),
    newDecryptableAvailableBalance: newDecryptableBalance as never,
    expectedPendingBalanceCreditCounter,
  });
}

export function buildApplyPendingBalanceTransaction(
  applyInstruction: Instruction,
  recentBlockhash: string,
  lastValidBlockHeight: bigint,
  feePayer: string
): ReturnType<typeof compileTransaction> {
  const feePayerAddress = address(feePayer);

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([applyInstruction], m),
  );

  return compileTransaction(transactionMessage);
}

// =============================================================================
// Context State Keypair Generation
// =============================================================================

export function generateContextStateKeypair(): { secretKey: Uint8Array; address: string } {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    secretKey,
    address: encodeBase58(publicKey),
  };
}

export function signWithKeypair(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

// =============================================================================
// Split Proof Transfer Transactions
// =============================================================================

function buildComputeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  data[1] = units & 0xff;
  data[2] = (units >> 8) & 0xff;
  data[3] = (units >> 16) & 0xff;
  data[4] = (units >> 24) & 0xff;
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data,
  };
}

function buildCreateAccountInstructionManual(
  payer: string,
  newAccount: string,
  lamports: bigint,
  space: number,
  owner: string
): Instruction {
  const data = new Uint8Array(4 + 8 + 8 + 32);
  data[0] = 0; data[1] = 0; data[2] = 0; data[3] = 0; // CreateAccount = 0 as u32
  data.set(numberToLEBytes(lamports, 8), 4);
  data.set(numberToLEBytes(BigInt(space), 8), 12);
  data.set(decodeBase58(owner), 20);

  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: address(payer), role: 3 }, // WRITABLE_SIGNER
      { address: address(newAccount), role: 3 }, // WRITABLE_SIGNER
    ],
    data,
  };
}

function buildVerifyProofInstruction(
  proofType: 'equality' | 'validity2' | 'validity3' | 'rangeU128',
  proofData: Uint8Array,
  contextStateAccount: string,
  contextStateAuthority: string
): Instruction {
  let discriminator: number;
  switch (proofType) {
    case 'equality':
      discriminator = ZK_INSTRUCTION.VerifyCiphertextCommitmentEquality;
      break;
    case 'validity2':
      discriminator = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext2HandlesValidity;
      break;
    case 'validity3':
      discriminator = ZK_INSTRUCTION.VerifyBatchedGroupedCiphertext3HandlesValidity;
      break;
    case 'rangeU128':
      discriminator = ZK_INSTRUCTION.VerifyBatchedRangeProofU128;
      break;
  }

  const data = new Uint8Array(1 + proofData.length);
  data[0] = discriminator;
  data.set(proofData, 1);

  return {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [
      { address: address(contextStateAccount), role: 1 }, // WRITABLE
      { address: address(contextStateAuthority), role: 0 }, // READONLY
    ],
    data,
  };
}

function buildCloseContextStateInstruction(
  contextStateAccount: string,
  lamportsDestination: string,
  contextStateAuthority: string
): Instruction {
  const data = new Uint8Array(1);
  data[0] = ZK_INSTRUCTION.CloseContextState;

  return {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [
      { address: address(contextStateAccount), role: 1 }, // WRITABLE
      { address: address(lamportsDestination), role: 1 }, // WRITABLE
      { address: address(contextStateAuthority), role: 2 }, // READONLY_SIGNER
    ],
    data,
  };
}

async function getContextStateRent(
  rpcUrl: string,
  proofType: 'equality' | 'validity2' | 'validity3' | 'rangeU128'
): Promise<bigint> {
  const space = CONTEXT_STATE_SIZES[proofType];
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMinimumBalanceForRentExemption',
      params: [space]
    })
  });
  const data = await response.json();
  return BigInt(data.result);
}

export async function buildSplitProofTransferTransactions(
  senderTokenAccountAddress: string,
  recipientTokenAccountAddress: string,
  mintAddress: string,
  senderAddress: string,
  transferProofs: TransferProofs,
  recentBlockhash: string,
  lastValidBlockHeight: bigint,
  rpcUrl: string,
  equalityContextKeypair: { secretKey: Uint8Array; address: string },
  validityContextKeypair: { secretKey: Uint8Array; address: string },
  rangeContextKeypair: { secretKey: Uint8Array; address: string }
): Promise<{
  transactions: {
    name: string;
    compiled: ReturnType<typeof compileTransaction>;
    additionalSigners?: Uint8Array[];
  }[];
}> {
  // The on-chain processor always expects 3-handle validity proofs
  const validityType = 'validity3' as const;

  const equalityRent = await getContextStateRent(rpcUrl, 'equality');
  const validityRent = await getContextStateRent(rpcUrl, validityType);
  const rangeRent = await getContextStateRent(rpcUrl, 'rangeU128');

  const feePayerAddress = address(senderAddress);
  const transactions: { name: string; compiled: ReturnType<typeof compileTransaction>; additionalSigners?: Uint8Array[] }[] = [];

  // TX 1: Create + verify equality proof
  const tx1Message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([
      buildComputeUnitLimitInstruction(COMPUTE_UNITS.equality),
      buildCreateAccountInstructionManual(senderAddress, equalityContextKeypair.address, equalityRent, CONTEXT_STATE_SIZES.equality, ZK_PROOF_PROGRAM_ID),
      buildVerifyProofInstruction('equality', transferProofs.equalityProofData, equalityContextKeypair.address, senderAddress),
    ], m),
  );
  transactions.push({ name: 'Create & verify equality proof', compiled: compileTransaction(tx1Message), additionalSigners: [equalityContextKeypair.secretKey] });

  // TX 2: Create + verify validity proof
  const validityContextSize = CONTEXT_STATE_SIZES.validity3;
  const tx2Message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([
      buildComputeUnitLimitInstruction(COMPUTE_UNITS.validity),
      buildCreateAccountInstructionManual(senderAddress, validityContextKeypair.address, validityRent, validityContextSize, ZK_PROOF_PROGRAM_ID),
      buildVerifyProofInstruction(validityType, transferProofs.validityProofData, validityContextKeypair.address, senderAddress),
    ], m),
  );
  transactions.push({ name: 'Create & verify validity proof', compiled: compileTransaction(tx2Message), additionalSigners: [validityContextKeypair.secretKey] });

  // TX 3: Create range context
  const tx3Message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([
      buildCreateAccountInstructionManual(senderAddress, rangeContextKeypair.address, rangeRent, CONTEXT_STATE_SIZES.rangeU128, ZK_PROOF_PROGRAM_ID),
    ], m),
  );
  transactions.push({ name: 'Create range context', compiled: compileTransaction(tx3Message), additionalSigners: [rangeContextKeypair.secretKey] });

  // TX 4: Verify range proof
  const tx4Message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([
      buildVerifyProofInstruction('rangeU128', transferProofs.rangeProofData, rangeContextKeypair.address, senderAddress),
    ], m),
  );
  transactions.push({ name: 'Verify range proof', compiled: compileTransaction(tx4Message) });

  // TX 5: Execute transfer + close contexts
  //
  // The @solana-program/token-2022 SDK has two bugs in the transfer instruction:
  // 1. It includes Token-2022 program ID as placeholder for null instructionsSysvar account
  // 2. It omits the two auditor ciphertext fields (transfer_amount_auditor_ciphertext_lo/hi)
  //    from the instruction data, producing 41 bytes instead of the expected 169 bytes.
  //
  // On-chain TransferInstructionData layout (167 bytes, plus 2-byte discriminator = 169 total):
  //   [0]    u8  discriminator = 27 (ConfidentialTransferExtension)
  //   [1]    u8  sub = 7 (Transfer)
  //   [2-37] DecryptableBalance (36 bytes) = newSourceDecryptableAvailableBalance
  //   [38-101] PodElGamalCiphertext (64 bytes) = transfer_amount_auditor_ciphertext_lo
  //   [102-165] PodElGamalCiphertext (64 bytes) = transfer_amount_auditor_ciphertext_hi
  //   [166]  i8  equality_proof_instruction_offset
  //   [167]  i8  ciphertext_validity_proof_instruction_offset
  //   [168]  i8  range_proof_instruction_offset
  //
  // When the mint has no auditor (auditor_elgamal_pubkey is zero), both ciphertext fields are zero.

  // Build transfer instruction FROM SCRATCH (bypass SDK completely to avoid bugs)
  //
  // On-chain TransferInstructionData layout (169 bytes total):
  //   [0]      u8  discriminator = 27 (ConfidentialTransferExtension)
  //   [1]      u8  sub = 7 (Transfer)
  //   [2-37]   DecryptableBalance (36 bytes) = newSourceDecryptableAvailableBalance
  //   [38-101] PodElGamalCiphertext (64 bytes) = transfer_amount_auditor_ciphertext_lo
  //   [102-165] PodElGamalCiphertext (64 bytes) = transfer_amount_auditor_ciphertext_hi
  //   [166]    i8  equality_proof_instruction_offset = 0
  //   [167]    i8  ciphertext_validity_proof_instruction_offset = 0
  //   [168]    i8  range_proof_instruction_offset = 0
  //
  // On-chain process_transfer reads accounts via next_account_info():
  //   0: source token account (writable, owned by Token-2022)
  //   1: mint (readonly, owned by Token-2022)
  //   2: destination token account (writable, owned by Token-2022)
  //   -- when all offsets are 0, NO instructions sysvar is consumed --
  //   3: equality proof context state (readonly, owned by ZK proof program)
  //   4: validity proof context state (readonly, owned by ZK proof program)
  //   5: range proof context state (readonly, owned by ZK proof program)
  //   6: authority (readonly signer, token account owner)

  // Build instruction data manually
  const transferData = new Uint8Array(169);
  transferData[0] = 27; // ConfidentialTransferExtension discriminator
  transferData[1] = 7;  // Transfer sub-discriminator
  transferData.set(transferProofs.newDecryptableBalance.slice(0, 36), 2); // DecryptableBalance
  transferData.set(transferProofs.auditorCiphertextLo, 38);   // auditor ciphertext lo (64 bytes)
  transferData.set(transferProofs.auditorCiphertextHi, 102);  // auditor ciphertext hi (64 bytes)
  transferData[166] = 0; // equality proof offset = 0 (context state)
  transferData[167] = 0; // validity proof offset = 0 (context state)
  transferData[168] = 0; // range proof offset = 0 (context state)

  // AccountRole enum values: READONLY=0, WRITABLE=1, READONLY_SIGNER=2, WRITABLE_SIGNER=3
  const transferInstruction: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: address(senderTokenAccountAddress), role: 1 },  // sourceToken: WRITABLE
      { address: address(mintAddress), role: 0 },                  // mint: READONLY
      { address: address(recipientTokenAccountAddress), role: 1 }, // destinationToken: WRITABLE
      { address: address(equalityContextKeypair.address), role: 0 },  // equality ctx: READONLY
      { address: address(validityContextKeypair.address), role: 0 },  // validity ctx: READONLY
      { address: address(rangeContextKeypair.address), role: 0 },     // range ctx: READONLY
      { address: address(senderAddress), role: 2 },                   // authority: READONLY_SIGNER
    ],
    data: transferData,
  };

  // Debug logging
  console.log('=== MANUALLY BUILT TRANSFER INSTRUCTION ===');
  console.log('Program:', String(transferInstruction.programAddress));
  console.log('Data length:', transferData.length, '(expected 169)');
  console.log('Data[0]:', transferData[0], '(expected 27 = CT extension)');
  console.log('Data[1]:', transferData[1], '(expected 7 = Transfer)');
  console.log('Data[166-168]:', transferData[166], transferData[167], transferData[168], '(expected 0 0 0 = context state offsets)');
  transferInstruction.accounts?.forEach((a, i) => {
    const roles = ['READONLY', 'WRITABLE', 'READONLY_SIGNER', 'WRITABLE_SIGNER'];
    console.log(`  Account[${i}]: ${String(a.address)} ${roles[a.role] || a.role}`);
  });

  // TX 5: Transfer only (no close instructions - for debugging)
  const tx5Message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(recentBlockhash), lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([
      buildComputeUnitLimitInstruction(COMPUTE_UNITS.transfer),
      transferInstruction,
    ], m),
  );
  transactions.push({ name: 'Execute transfer & close contexts', compiled: compileTransaction(tx5Message) });

  return { transactions };
}

// =============================================================================
// Legacy Compatibility Functions
// =============================================================================

export function parseElGamalPubkeyFromAccountInfo(
  ctAccountState: { elgamalPubkey: string }
): Uint8Array {
  return decodeBase64(ctAccountState.elgamalPubkey);
}
