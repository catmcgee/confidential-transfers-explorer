import { sha512 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  pipe,
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  type Instruction,
  type Address,
} from '@solana/kit';

const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const SYSVAR_INSTRUCTIONS_ID = 'Sysvar1nstructions1111111111111111111111111' as Address;
const ZK_PROOF_PROGRAM_ID = 'ZkE1Gama1Proof11111111111111111111111111111' as Address;
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

// ZK Proof Program Instruction Discriminators
// Discovered by testing against the zk-edge.surfnet.dev RPC
// Note: This differs from standard Solana mainnet - this is for the custom surfnet RPC
const ZK_INSTRUCTION = {
  CloseContextState: 0,
  VerifyZeroCiphertext: 1,
  VerifyCiphertextCiphertextEquality: 2,
  VerifyCiphertextCommitmentEquality: 3,  // equality proof
  VerifyPubkeyValidity: 4,
  VerifyPercentageWithCap: 5,
  VerifyBatchedRangeProofU64: 6,
  VerifyBatchedRangeProofU128: 7,         // range proof
  VerifyBatchedRangeProofU256: 8,
  VerifyGroupedCiphertext2HandlesValidity: 9,
  VerifyBatchedGroupedCiphertext2HandlesValidity: 10,  // validity2 proof
  VerifyGroupedCiphertext3HandlesValidity: 11,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,  // validity3 proof
} as const;

// Context State Account sizes (context data + 33 byte header: 32 pubkey + 1 discriminator)
// Discovered by testing against the zk-edge.surfnet.dev RPC
const CONTEXT_STATE_SIZES = {
  // CiphertextCommitmentEqualityProofContext: 128 bytes + 33 header = 161 bytes
  equality: 161,
  // BatchedGroupedCiphertext2HandlesValidityProofContext: 256 bytes + 33 header = 289 bytes
  validity2: 289,
  // BatchedGroupedCiphertext3HandlesValidityProofContext: needs testing, estimate ~369 bytes
  validity3: 369,
  // BatchedRangeProofU128Context: 264 bytes + 33 header = 297 bytes
  rangeU128: 297,
} as const;

// ed25519 group order (L)
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

// Lazy-loaded WASM module
let zkSdk: typeof import('@solana/zk-sdk/bundler') | null = null;

async function getZkSdk() {
  if (!zkSdk) {
    zkSdk = await import('@solana/zk-sdk/bundler');
  }
  return zkSdk;
}

/**
 * Derives an ElGamal keypair from a wallet signature using the official Solana ZK SDK.
 */
export async function deriveElGamalKeypair(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  tokenAccountAddress: string
): Promise<{ secretKey: Uint8Array; publicKey: Uint8Array; keypair: unknown }> {
  const sdk = await getZkSdk();

  // Create the message to sign (matches Rust: "ElGamalSecretKey" + token_account_bytes)
  const prefix = new TextEncoder().encode('ElGamalSecretKey');
  const accountBytes = decodeBase58(tokenAccountAddress);
  const message = new Uint8Array(prefix.length + accountBytes.length);
  message.set(prefix);
  message.set(accountBytes, prefix.length);

  // Sign the message
  const signature = await signMessage(message);

  // Hash the signature to derive the secret scalar
  const hash = sha512(signature);

  // Take the first 32 bytes and reduce mod group order
  const secretScalar = bytesToNumberLE(hash.slice(0, 32)) % ED25519_ORDER;
  const secretKeyBytes = numberToLEBytes(secretScalar, 32);

  // Create ElGamal keypair using the WASM SDK
  const secretKey = sdk.ElGamalSecretKey.fromBytes(secretKeyBytes);
  const keypair = sdk.ElGamalKeypair.fromSecretKey(secretKey);
  const publicKey = keypair.pubkey().toBytes();

  return { secretKey: secretKeyBytes, publicKey, keypair };
}

/**
 * Generates a PubkeyValidityProof using the official Solana ZK SDK.
 * This handles all the Merlin transcript complexity internally.
 */
export async function generatePubkeyValidityProofData(
  keypair: unknown
): Promise<Uint8Array> {
  const sdk = await getZkSdk();

  // Create the proof - this uses the correct Merlin transcript internally
  const proofData = new sdk.PubkeyValidityProofData(keypair as InstanceType<typeof sdk.ElGamalKeypair>);

  // Verify it locally first (optional sanity check)
  proofData.verify();

  return proofData.toBytes();
}

/**
 * Creates the encrypted zero balance (for initial account configuration).
 */
export function createDecryptableZeroBalance(): Uint8Array {
  // The decryptable balance is 36 bytes:
  // - 4 bytes: low bits of amount (u32 LE)
  // - 32 bytes: AES ciphertext (for owner decryption)
  // For initial zero balance, everything is zero
  return new Uint8Array(36);
}

/**
 * Builds the ConfigureConfidentialTransferAccount instruction data.
 */
export function buildConfigureAccountInstructionData(
  decryptableZeroBalance: Uint8Array,
  maximumPendingBalanceCreditCounter: bigint = 65536n,
  proofInstructionOffset: number = -1
): Uint8Array {
  const data = new Uint8Array(2 + 36 + 8 + 1);
  let offset = 0;

  // Extension discriminator (ConfidentialTransfer = 27)
  data[offset++] = 27;
  // Instruction discriminator (ConfigureAccount = 2)
  data[offset++] = 2;

  // Decryptable zero balance (36 bytes)
  data.set(decryptableZeroBalance, offset);
  offset += 36;

  // Maximum pending balance credit counter (u64, little endian)
  const counterBytes = numberToLEBytes(maximumPendingBalanceCreditCounter, 8);
  data.set(counterBytes, offset);
  offset += 8;

  // Proof instruction offset (i8) - signed byte
  data[offset++] = proofInstructionOffset & 0xff;

  return data;
}

/**
 * Builds the Reallocate instruction data.
 * Format: discriminator (1) + extension types (2 bytes each u16 LE, NO vec length prefix)
 * The number of extensions is derived from the remaining data length.
 */
function buildReallocateInstructionData(): Uint8Array {
  const data = new Uint8Array(3);
  data[0] = 29; // Reallocate instruction discriminator
  // ExtensionType::ConfidentialTransferAccount = 5 as u16 LE
  data[1] = 5;
  data[2] = 0;
  return data;
}

/**
 * Builds instructions for configuring a token account for confidential transfers.
 * Returns Kit-compatible Instruction objects.
 */
export async function buildConfigureCtInstructions(
  tokenAccountAddress: string,
  mintAddress: string,
  ownerAddress: string,
  elgamalPublicKey: Uint8Array,
  keypair: unknown
): Promise<{
  reallocateInstruction: Instruction;
  proofInstruction: Instruction;
  configureInstruction: Instruction;
}> {
  const tokenAccount = address(tokenAccountAddress);
  const mint = address(mintAddress);
  const owner = address(ownerAddress);

  // 1. Reallocate instruction
  // Accounts: token_account (writable), payer (writable+signer), system_program, authority (signer)
  // Since payer == authority, they both reference the same address
  const reallocateInstruction: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: tokenAccount, role: 1 }, // AccountRole.WRITABLE - token account
      { address: owner, role: 3 }, // AccountRole.WRITABLE_SIGNER - payer
      { address: SYSTEM_PROGRAM_ID, role: 0 }, // AccountRole.READONLY - system program
      { address: owner, role: 2 }, // AccountRole.READONLY_SIGNER - authority (same as payer)
    ],
    data: buildReallocateInstructionData(),
  };

  // 2. ZK Proof instruction - generate using WASM SDK
  const proofDataBytes = await generatePubkeyValidityProofData(keypair);

  // The proof data from the SDK is the full PubkeyValidityProofData structure
  // For the instruction, we need: discriminator (1) + context (32) + proof (64) = 97 bytes
  const proofInstructionData = new Uint8Array(1 + proofDataBytes.length);
  proofInstructionData[0] = 4; // VerifyPubkeyValidity instruction
  proofInstructionData.set(proofDataBytes, 1);

  const proofInstruction: Instruction = {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [],
    data: proofInstructionData,
  };

  // 3. ConfigureAccount instruction
  // proof_instruction_offset = 1 means proof is in the NEXT instruction (after configure)
  const decryptableZeroBalance = createDecryptableZeroBalance();
  const configureData = buildConfigureAccountInstructionData(
    decryptableZeroBalance,
    65536n,
    1  // proof comes AFTER configure
  );

  const configureInstruction: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: tokenAccount, role: 1 }, // AccountRole.WRITABLE
      { address: mint, role: 0 }, // AccountRole.READONLY
      { address: SYSVAR_INSTRUCTIONS_ID, role: 0 }, // AccountRole.READONLY
      { address: owner, role: 2 }, // AccountRole.READONLY_SIGNER
    ],
    data: configureData,
  };

  return {
    reallocateInstruction,
    proofInstruction,
    configureInstruction,
  };
}

/**
 * Builds a complete compiled transaction ready for signing.
 * Uses the Solana Kit functional approach.
 */
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
    // Order: reallocate, configure, proof
    // Configure references the proof at offset +1 (next instruction)
    (m) => appendTransactionMessageInstructions(
      [reallocateInstruction, configureInstruction, proofInstruction],
      m
    ),
  );

  return compileTransaction(transactionMessage);
}

/**
 * Serializes a compiled transaction to base64 for wallet signing.
 */
export function serializeTransactionToBase64(
  compiledTransaction: ReturnType<typeof compileTransaction>
): string {
  return getBase64EncodedWireTransaction(compiledTransaction);
}

// ============================================================================
// DEPOSIT - Move tokens from public balance to pending confidential balance
// ============================================================================

/**
 * Builds the Deposit instruction data.
 * Format: extension_discriminator (1) + instruction_discriminator (1) + amount (8) + decimals (1) = 11 bytes
 */
function buildDepositInstructionData(amount: bigint, decimals: number): Uint8Array {
  const data = new Uint8Array(11);
  data[0] = 27; // ConfidentialTransferExtension
  data[1] = 5;  // Deposit
  // Amount as u64 LE (bytes 2-9)
  const amountBytes = numberToLEBytes(amount, 8);
  data.set(amountBytes, 2);
  // Decimals (byte 10)
  data[10] = decimals;
  return data;
}

/**
 * Builds a Deposit instruction to move tokens from public to pending confidential balance.
 */
export function buildDepositInstruction(
  tokenAccountAddress: string,
  mintAddress: string,
  ownerAddress: string,
  amount: bigint,
  decimals: number
): Instruction {
  const tokenAccount = address(tokenAccountAddress);
  const mint = address(mintAddress);
  const owner = address(ownerAddress);

  return {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: tokenAccount, role: 1 }, // WRITABLE - token account
      { address: mint, role: 0 }, // READONLY - mint
      { address: owner, role: 2 }, // READONLY_SIGNER - owner
    ],
    data: buildDepositInstructionData(amount, decimals),
  };
}

/**
 * Builds a complete Deposit transaction.
 */
export function buildDepositTransaction(
  tokenAccountAddress: string,
  mintAddress: string,
  ownerAddress: string,
  amount: bigint,
  decimals: number,
  recentBlockhash: string,
  lastValidBlockHeight: bigint
): ReturnType<typeof compileTransaction> {
  const depositInstruction = buildDepositInstruction(
    tokenAccountAddress,
    mintAddress,
    ownerAddress,
    amount,
    decimals
  );

  const feePayerAddress = address(ownerAddress);

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

// ============================================================================
// APPLY PENDING BALANCE - Move pending balance to available balance
// ============================================================================

/**
 * Derives an AES key from a wallet signature for encrypting/decrypting balances.
 */
export async function deriveAeKey(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  tokenAccountAddress: string
): Promise<{ aeKey: unknown; aeKeyBytes: Uint8Array }> {
  const sdk = await getZkSdk();

  // Create the message to sign (matches Rust: "AesKey" + token_account_bytes)
  const prefix = new TextEncoder().encode('AeKey');
  const accountBytes = decodeBase58(tokenAccountAddress);
  const message = new Uint8Array(prefix.length + accountBytes.length);
  message.set(prefix);
  message.set(accountBytes, prefix.length);

  // Sign the message
  const signature = await signMessage(message);

  // Hash the signature to derive the AES key
  const hash = sha512(signature);

  // Take the first 16 bytes as the AES key
  const aeKeyBytes = hash.slice(0, 16);

  // Create AeKey using the WASM SDK
  const aeKey = sdk.AeKey.fromBytes(aeKeyBytes);

  return { aeKey, aeKeyBytes };
}

/**
 * Builds the ApplyPendingBalance instruction data.
 * Format: extension_discriminator (1) + instruction_discriminator (1) +
 *         expected_pending_balance_credit_counter (8) + new_decryptable_available_balance (36)
 */
function buildApplyPendingBalanceInstructionData(
  expectedPendingBalanceCreditCounter: bigint,
  newDecryptableAvailableBalance: Uint8Array
): Uint8Array {
  const data = new Uint8Array(46);
  data[0] = 27; // ConfidentialTransferExtension
  data[1] = 8;  // ApplyPendingBalance
  // Expected pending balance credit counter as u64 LE
  const counterBytes = numberToLEBytes(expectedPendingBalanceCreditCounter, 8);
  data.set(counterBytes, 2);
  // New decryptable available balance (36 bytes)
  data.set(newDecryptableAvailableBalance, 10);
  return data;
}

/**
 * Creates a decryptable balance from an amount using AES encryption.
 * Format: amount_lo (4 bytes u32 LE) + AES ciphertext (32 bytes)
 */
export async function createDecryptableBalance(
  aeKey: unknown,
  amount: bigint
): Promise<Uint8Array> {
  const sdk = await getZkSdk();
  const key = aeKey as InstanceType<typeof sdk.AeKey>;

  // Encrypt the amount
  const ciphertext = key.encrypt(amount);
  const ciphertextBytes = ciphertext.toBytes();

  return ciphertextBytes;
}

/**
 * Builds an ApplyPendingBalance instruction.
 */
export async function buildApplyPendingBalanceInstruction(
  tokenAccountAddress: string,
  ownerAddress: string,
  expectedPendingBalanceCreditCounter: bigint,
  newAvailableBalance: bigint,
  aeKey: unknown
): Promise<Instruction> {
  const tokenAccount = address(tokenAccountAddress);
  const owner = address(ownerAddress);

  // Create the new decryptable balance
  const newDecryptableAvailableBalance = await createDecryptableBalance(aeKey, newAvailableBalance);

  return {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: tokenAccount, role: 1 }, // WRITABLE - token account
      { address: owner, role: 2 }, // READONLY_SIGNER - owner
    ],
    data: buildApplyPendingBalanceInstructionData(
      expectedPendingBalanceCreditCounter,
      newDecryptableAvailableBalance
    ),
  };
}

/**
 * Builds a complete ApplyPendingBalance transaction.
 */
export async function buildApplyPendingBalanceTransaction(
  tokenAccountAddress: string,
  ownerAddress: string,
  expectedPendingBalanceCreditCounter: bigint,
  newAvailableBalance: bigint,
  aeKey: unknown,
  recentBlockhash: string,
  lastValidBlockHeight: bigint
): Promise<ReturnType<typeof compileTransaction>> {
  const applyInstruction = await buildApplyPendingBalanceInstruction(
    tokenAccountAddress,
    ownerAddress,
    expectedPendingBalanceCreditCounter,
    newAvailableBalance,
    aeKey
  );

  const feePayerAddress = address(ownerAddress);

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

// ============================================================================
// CONFIDENTIAL TRANSFER - Transfer with ZK proofs
// ============================================================================

/**
 * Splits a u64 amount into lo (16 bits) and hi (48 bits) parts for batched range proofs.
 */
function splitAmount(amount: bigint): { lo: bigint; hi: bigint } {
  const lo = amount & 0xFFFFn; // Lower 16 bits
  const hi = amount >> 16n;    // Upper 48 bits (but we treat as 32 for the proof)
  return { lo, hi };
}

/**
 * Generates all the data needed for a confidential transfer.
 * This includes the three ZK proofs and encrypted amounts.
 */
export async function generateTransferProofData(
  senderKeypair: unknown,
  senderCurrentBalance: bigint,
  transferAmount: bigint,
  recipientElGamalPubkeyBytes: Uint8Array,
  auditorElGamalPubkeyBytes?: Uint8Array
): Promise<{
  equalityProofData: Uint8Array;
  validityProofData: Uint8Array;
  rangeProofData: Uint8Array;
  encryptedAmountLo: Uint8Array;
  encryptedAmountHi: Uint8Array;
}> {
  const sdk = await getZkSdk();

  const senderKp = senderKeypair as InstanceType<typeof sdk.ElGamalKeypair>;
  const senderPubkey = senderKp.pubkey();
  const senderSecret = senderKp.secret();

  // Parse recipient pubkey
  const recipientPubkey = sdk.ElGamalPubkey.fromBytes(recipientElGamalPubkeyBytes);

  // Split amount into lo (16 bits) and hi (48 bits, but we use 32 for proof)
  const { lo: amountLo, hi: amountHi } = splitAmount(transferAmount);

  // Calculate new sender balance
  const newSenderBalance = senderCurrentBalance - transferAmount;
  const { lo: newBalanceLo, hi: newBalanceHi } = splitAmount(newSenderBalance);

  // Generate random openings for the encryptions
  const openingLo = new sdk.PedersenOpening();
  const openingHi = new sdk.PedersenOpening();
  const newBalanceOpeningLo = new sdk.PedersenOpening();
  const newBalanceOpeningHi = new sdk.PedersenOpening();

  // Encrypt the transfer amounts for recipient (grouped ciphertext with 2 handles: source, dest)
  // Or 3 handles if auditor is present
  let encryptedAmountLo: Uint8Array;
  let encryptedAmountHi: Uint8Array;
  let validityProofData: Uint8Array;

  if (auditorElGamalPubkeyBytes && auditorElGamalPubkeyBytes.length > 0) {
    // 3-handle case (sender, recipient, auditor)
    const auditorPubkey = sdk.ElGamalPubkey.fromBytes(auditorElGamalPubkeyBytes);

    const groupedCiphertextLo = sdk.GroupedElGamalCiphertext3Handles.encryptWith(
      senderPubkey, recipientPubkey, auditorPubkey, amountLo, openingLo
    );
    const groupedCiphertextHi = sdk.GroupedElGamalCiphertext3Handles.encryptWith(
      senderPubkey, recipientPubkey, auditorPubkey, amountHi, openingHi
    );

    encryptedAmountLo = groupedCiphertextLo.toBytes();
    encryptedAmountHi = groupedCiphertextHi.toBytes();

    // Create batched validity proof for 3 handles
    const validityProof = new sdk.BatchedGroupedCiphertext3HandlesValidityProofData(
      senderPubkey, recipientPubkey, auditorPubkey,
      groupedCiphertextLo, groupedCiphertextHi,
      amountLo, amountHi,
      openingLo, openingHi
    );
    validityProof.verify();
    validityProofData = validityProof.toBytes();
  } else {
    // 2-handle case (sender, recipient only)
    const groupedCiphertextLo = sdk.GroupedElGamalCiphertext2Handles.encryptWith(
      senderPubkey, recipientPubkey, amountLo, openingLo
    );
    const groupedCiphertextHi = sdk.GroupedElGamalCiphertext2Handles.encryptWith(
      senderPubkey, recipientPubkey, amountHi, openingHi
    );

    encryptedAmountLo = groupedCiphertextLo.toBytes();
    encryptedAmountHi = groupedCiphertextHi.toBytes();

    // Create batched validity proof for 2 handles
    const validityProof = new sdk.BatchedGroupedCiphertext2HandlesValidityProofData(
      senderPubkey, recipientPubkey,
      groupedCiphertextLo, groupedCiphertextHi,
      amountLo, amountHi,
      openingLo, openingHi
    );
    validityProof.verify();
    validityProofData = validityProof.toBytes();
  }

  // Create commitments for the new sender balance
  const newBalanceCommitmentLo = sdk.PedersenCommitment.from(newBalanceLo, newBalanceOpeningLo);
  const newBalanceCommitmentHi = sdk.PedersenCommitment.from(newBalanceHi, newBalanceOpeningHi);

  // Encrypt new balance for sender to create equality proof source ciphertext
  const senderNewBalanceCiphertext = senderPubkey.encryptWith(newSenderBalance, newBalanceOpeningLo);

  // Create the equality proof (proves sender's remaining balance encryption is valid)
  // This proves that the ciphertext encrypts the same value as the commitment
  const equalityProof = new sdk.CiphertextCommitmentEqualityProofData(
    senderKp,
    senderNewBalanceCiphertext,
    newBalanceCommitmentLo,
    newBalanceOpeningLo,
    newBalanceLo
  );
  equalityProof.verify();
  const equalityProofData = equalityProof.toBytes();

  // Create the range proof (proves all amounts are non-negative and within range)
  // We need to prove: newBalanceLo, newBalanceHi, amountLo, amountHi are all in valid ranges
  const commitments = [
    newBalanceCommitmentLo,
    newBalanceCommitmentHi,
    sdk.PedersenCommitment.from(amountLo, openingLo),
    sdk.PedersenCommitment.from(amountHi, openingHi),
  ];
  const amounts = new BigUint64Array([
    BigInt(newBalanceLo),
    BigInt(newBalanceHi),
    BigInt(amountLo),
    BigInt(amountHi),
  ]);
  // Bit lengths must sum to 128 for BatchedRangeProofU128Data
  const bitLengths = new Uint8Array([16, 32, 16, 64]); // 16 + 32 + 16 + 64 = 128
  const openings = [newBalanceOpeningLo, newBalanceOpeningHi, openingLo, openingHi];

  const rangeProof = new sdk.BatchedRangeProofU128Data(commitments, amounts, bitLengths, openings);
  rangeProof.verify();
  const rangeProofData = rangeProof.toBytes();

  return {
    equalityProofData,
    validityProofData,
    rangeProofData,
    encryptedAmountLo,
    encryptedAmountHi,
  };
}

/**
 * Builds the Transfer instruction data for INLINE proofs.
 */
function buildTransferInstructionDataInline(
  newDecryptableAvailableBalance: Uint8Array,
  proofInstructionOffset: number
): Uint8Array {
  // Format: extension (1) + instruction (1) + new_decryptable_balance (36) + proof_offset (1)
  const data = new Uint8Array(39);
  data[0] = 27; // ConfidentialTransferExtension
  data[1] = 7;  // Transfer
  data.set(newDecryptableAvailableBalance, 2);
  data[38] = proofInstructionOffset & 0xff;
  return data;
}

// ============================================================================
// SPLIT PROOF TRANSFER (Multi-Transaction)
// ============================================================================

/**
 * Generates an ed25519 keypair for a context state account.
 * Uses @noble/curves/ed25519 for proper key derivation.
 */
export function generateContextStateKeypair(): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  // Generate 32 random bytes for the secret key
  const secretKey = new Uint8Array(32);
  crypto.getRandomValues(secretKey);

  // Derive the public key using ed25519
  const publicKey = ed25519.getPublicKey(secretKey);

  // Convert to base58 address
  const addressStr = encodeBase58(publicKey);

  return {
    secretKey,
    publicKey,
    address: addressStr,
  };
}

/**
 * Signs a message with an ed25519 secret key.
 * Used for partial signing of transactions with context state keypairs.
 */
export function signWithKeypair(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

/**
 * Gets the public key from a secret key.
 */
export function getPublicKeyFromSecretKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

/**
 * Builds a SystemProgram::CreateAccount instruction to create a context state account.
 */
export function buildCreateAccountInstruction(
  payer: string,
  newAccount: string,
  lamports: bigint,
  space: number,
  owner: string
): Instruction {
  // CreateAccount instruction layout:
  // 4 bytes: instruction index (0 = CreateAccount)
  // 8 bytes: lamports (little-endian u64)
  // 8 bytes: space (little-endian u64)
  // 32 bytes: owner pubkey
  const data = new Uint8Array(4 + 8 + 8 + 32);

  // Instruction index 0 = CreateAccount
  data[0] = 0;
  data[1] = 0;
  data[2] = 0;
  data[3] = 0;

  // Lamports (8 bytes LE)
  const lamportsBytes = numberToLEBytes(lamports, 8);
  data.set(lamportsBytes, 4);

  // Space (8 bytes LE)
  const spaceBytes = numberToLEBytes(BigInt(space), 8);
  data.set(spaceBytes, 12);

  // Owner pubkey (32 bytes)
  const ownerBytes = decodeBase58(owner);
  data.set(ownerBytes, 20);

  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: address(payer), role: 3 }, // WRITABLE_SIGNER - funding account
      { address: address(newAccount), role: 3 }, // WRITABLE_SIGNER - new account
    ],
    data,
  };
}

/**
 * Builds a proof verification instruction that writes to a context state account.
 * This is used for split proof transfers.
 */
export function buildVerifyProofWithContextInstruction(
  proofType: 'equality' | 'validity2' | 'validity3' | 'rangeU128',
  proofData: Uint8Array,
  contextStateAccount: string,
  contextStateAuthority: string
): Instruction {
  // Determine the instruction discriminator
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

  // Instruction data: discriminator (1 byte) + proof_data
  const data = new Uint8Array(1 + proofData.length);
  data[0] = discriminator;
  data.set(proofData, 1);

  return {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [
      { address: address(contextStateAccount), role: 1 }, // WRITABLE - context state to write
      { address: address(contextStateAuthority), role: 0 }, // READONLY - authority (can close later)
    ],
    data,
  };
}

/**
 * Builds a close context state instruction to recover rent.
 */
export function buildCloseContextStateInstruction(
  contextStateAccount: string,
  lamportsDestination: string,
  contextStateAuthority: string
): Instruction {
  // CloseContextState has no additional data beyond the discriminator
  const data = new Uint8Array(1);
  data[0] = ZK_INSTRUCTION.CloseContextState;

  return {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [
      { address: address(contextStateAccount), role: 1 }, // WRITABLE - account to close
      { address: address(lamportsDestination), role: 1 }, // WRITABLE - receives lamports
      { address: address(contextStateAuthority), role: 2 }, // READONLY_SIGNER - authority
    ],
    data,
  };
}

/**
 * Builds the Transfer instruction for use with context state accounts.
 * The proofs are referenced via context accounts instead of inline.
 */
export function buildTransferWithContextInstruction(
  senderTokenAccount: string,
  recipientTokenAccount: string,
  mint: string,
  sender: string,
  newDecryptableAvailableBalance: Uint8Array,
  equalityContextAccount: string,
  validityContextAccount: string,
  rangeContextAccount: string,
  encryptedTransferAmountLo: Uint8Array,
  encryptedTransferAmountHi: Uint8Array
): Instruction {
  // Transfer instruction data with context accounts:
  // extension (1) + instruction (1) + new_decryptable_balance (36) +
  // encrypted_amount_lo (96 for 2-handle, 128 for 3-handle) +
  // encrypted_amount_hi (96 for 2-handle, 128 for 3-handle)
  //
  // GroupedElGamalCiphertext2Handles = 32 (commitment) + 32 (handle1) + 32 (handle2) = 96 bytes
  // GroupedElGamalCiphertext3Handles = 32 (commitment) + 32*3 (handles) = 128 bytes

  const loSize = encryptedTransferAmountLo.length;
  const hiSize = encryptedTransferAmountHi.length;
  const dataSize = 2 + 36 + loSize + hiSize;

  const data = new Uint8Array(dataSize);
  data[0] = 27; // ConfidentialTransferExtension
  data[1] = 7;  // Transfer
  data.set(newDecryptableAvailableBalance, 2);
  data.set(encryptedTransferAmountLo, 38);
  data.set(encryptedTransferAmountHi, 38 + loSize);

  return {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: address(senderTokenAccount), role: 1 }, // WRITABLE - source
      { address: address(mint), role: 0 }, // READONLY - mint
      { address: address(recipientTokenAccount), role: 1 }, // WRITABLE - destination
      // Context state accounts for proofs
      { address: address(equalityContextAccount), role: 0 }, // READONLY - equality proof context
      { address: address(validityContextAccount), role: 0 }, // READONLY - validity proof context
      { address: address(rangeContextAccount), role: 0 }, // READONLY - range proof context
      { address: SYSVAR_INSTRUCTIONS_ID, role: 0 }, // READONLY - sysvar instructions (required)
      { address: address(sender), role: 2 }, // READONLY_SIGNER - authority
    ],
    data,
  };
}

/**
 * Type for tracking split proof transfer progress
 */
export interface SplitProofTransferProgress {
  step: 'generating_proofs' | 'creating_equality' | 'creating_validity' | 'creating_range' | 'verifying_range' | 'executing_transfer' | 'complete' | 'error';
  currentTransaction: number;
  totalTransactions: number;
  signature?: string;
  error?: string;
}

/**
 * Callback type for progress updates
 */
export type SplitProofProgressCallback = (progress: SplitProofTransferProgress) => void;

/**
 * Generates all proof data needed for a split proof transfer.
 * This is CPU-intensive and happens client-side.
 */
export async function generateSplitTransferProofs(
  senderKeypair: unknown,
  senderCurrentBalance: bigint,
  transferAmount: bigint,
  recipientElGamalPubkeyBytes: Uint8Array,
  auditorElGamalPubkeyBytes?: Uint8Array
): Promise<{
  equalityProofData: Uint8Array;
  validityProofData: Uint8Array;
  rangeProofData: Uint8Array;
  encryptedAmountLo: Uint8Array;
  encryptedAmountHi: Uint8Array;
  newDecryptableBalance: Uint8Array;
  hasAuditor: boolean;
}> {
  const sdk = await getZkSdk();

  const senderKp = senderKeypair as InstanceType<typeof sdk.ElGamalKeypair>;
  const senderPubkey = senderKp.pubkey();

  // Parse recipient pubkey
  const recipientPubkey = sdk.ElGamalPubkey.fromBytes(recipientElGamalPubkeyBytes);

  // Split amount into lo (16 bits) and hi (48 bits)
  const { lo: amountLo, hi: amountHi } = splitAmount(transferAmount);

  // Calculate new sender balance
  const newSenderBalance = senderCurrentBalance - transferAmount;
  const { lo: newBalanceLo, hi: newBalanceHi } = splitAmount(newSenderBalance);

  // Generate random openings for the encryptions
  const openingLo = new sdk.PedersenOpening();
  const openingHi = new sdk.PedersenOpening();
  const newBalanceOpeningLo = new sdk.PedersenOpening();
  const newBalanceOpeningHi = new sdk.PedersenOpening();

  // Encrypt the transfer amounts
  let encryptedAmountLo: Uint8Array;
  let encryptedAmountHi: Uint8Array;
  let validityProofData: Uint8Array;
  const hasAuditor = !!(auditorElGamalPubkeyBytes && auditorElGamalPubkeyBytes.length > 0);

  if (hasAuditor) {
    const auditorPubkey = sdk.ElGamalPubkey.fromBytes(auditorElGamalPubkeyBytes);

    const groupedCiphertextLo = sdk.GroupedElGamalCiphertext3Handles.encryptWith(
      senderPubkey, recipientPubkey, auditorPubkey, amountLo, openingLo
    );
    const groupedCiphertextHi = sdk.GroupedElGamalCiphertext3Handles.encryptWith(
      senderPubkey, recipientPubkey, auditorPubkey, amountHi, openingHi
    );

    encryptedAmountLo = groupedCiphertextLo.toBytes();
    encryptedAmountHi = groupedCiphertextHi.toBytes();

    const validityProof = new sdk.BatchedGroupedCiphertext3HandlesValidityProofData(
      senderPubkey, recipientPubkey, auditorPubkey,
      groupedCiphertextLo, groupedCiphertextHi,
      amountLo, amountHi,
      openingLo, openingHi
    );
    validityProof.verify();
    validityProofData = validityProof.toBytes();
  } else {
    const groupedCiphertextLo = sdk.GroupedElGamalCiphertext2Handles.encryptWith(
      senderPubkey, recipientPubkey, amountLo, openingLo
    );
    const groupedCiphertextHi = sdk.GroupedElGamalCiphertext2Handles.encryptWith(
      senderPubkey, recipientPubkey, amountHi, openingHi
    );

    encryptedAmountLo = groupedCiphertextLo.toBytes();
    encryptedAmountHi = groupedCiphertextHi.toBytes();

    const validityProof = new sdk.BatchedGroupedCiphertext2HandlesValidityProofData(
      senderPubkey, recipientPubkey,
      groupedCiphertextLo, groupedCiphertextHi,
      amountLo, amountHi,
      openingLo, openingHi
    );
    validityProof.verify();
    validityProofData = validityProof.toBytes();
  }

  // Create commitments for the new sender balance
  const newBalanceCommitmentLo = sdk.PedersenCommitment.from(newBalanceLo, newBalanceOpeningLo);

  // Encrypt newBalanceLo (NOT the full balance) for equality proof
  // The equality proof proves ciphertext and commitment encrypt/commit to the same value
  const senderNewBalanceCiphertextLo = senderPubkey.encryptWith(newBalanceLo, newBalanceOpeningLo);

  // Create the equality proof
  const equalityProof = new sdk.CiphertextCommitmentEqualityProofData(
    senderKp,
    senderNewBalanceCiphertextLo,
    newBalanceCommitmentLo,
    newBalanceOpeningLo,
    newBalanceLo
  );
  equalityProof.verify();
  const equalityProofData = equalityProof.toBytes();

  // Create the range proof
  const newBalanceCommitmentHi = sdk.PedersenCommitment.from(newBalanceHi, newBalanceOpeningHi);
  const commitments = [
    newBalanceCommitmentLo,
    newBalanceCommitmentHi,
    sdk.PedersenCommitment.from(amountLo, openingLo),
    sdk.PedersenCommitment.from(amountHi, openingHi),
  ];
  const amounts = new BigUint64Array([
    BigInt(newBalanceLo),
    BigInt(newBalanceHi),
    BigInt(amountLo),
    BigInt(amountHi),
  ]);
  const bitLengths = new Uint8Array([16, 32, 16, 64]);
  const openings = [newBalanceOpeningLo, newBalanceOpeningHi, openingLo, openingHi];

  const rangeProof = new sdk.BatchedRangeProofU128Data(commitments, amounts, bitLengths, openings);
  rangeProof.verify();
  const rangeProofData = rangeProof.toBytes();

  // Create new decryptable balance (for sender's records)
  // This is AES-encrypted version of the new balance
  const newDecryptableBalance = new Uint8Array(36); // Placeholder - needs AE key encryption
  const newBalanceBytes = numberToLEBytes(newSenderBalance, 4);
  newDecryptableBalance.set(newBalanceBytes, 0);

  return {
    equalityProofData,
    validityProofData,
    rangeProofData,
    encryptedAmountLo,
    encryptedAmountHi,
    newDecryptableBalance,
    hasAuditor,
  };
}

/**
 * Calculates the minimum rent-exempt balance for a context state account.
 */
export async function getContextStateRent(
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

/**
 * Builds a complete split proof transfer transaction set.
 * Returns an array of transactions to be signed and sent in sequence.
 */
export async function buildSplitProofTransferTransactions(
  senderTokenAccountAddress: string,
  recipientTokenAccountAddress: string,
  mintAddress: string,
  senderAddress: string,
  transferAmount: bigint,
  senderKeypair: unknown,
  senderAeKey: unknown,
  senderCurrentBalance: bigint,
  recipientElGamalPubkeyBytes: Uint8Array,
  recentBlockhash: string,
  lastValidBlockHeight: bigint,
  rpcUrl: string,
  equalityContextKeypair: { secretKey: Uint8Array; address: string },
  validityContextKeypair: { secretKey: Uint8Array; address: string },
  rangeContextKeypair: { secretKey: Uint8Array; address: string },
  auditorElGamalPubkeyBytes?: Uint8Array
): Promise<{
  proofData: Awaited<ReturnType<typeof generateSplitTransferProofs>>;
  transactions: {
    name: string;
    compiled: ReturnType<typeof compileTransaction>;
    additionalSigners?: Uint8Array[]; // Keypair secret keys for additional signers
  }[];
}> {
  // Generate all proofs first
  const proofData = await generateSplitTransferProofs(
    senderKeypair,
    senderCurrentBalance,
    transferAmount,
    recipientElGamalPubkeyBytes,
    auditorElGamalPubkeyBytes
  );

  // Create new decryptable balance with AE key
  const newBalance = senderCurrentBalance - transferAmount;
  const newDecryptableBalance = await createDecryptableBalance(senderAeKey, newBalance);

  // Get rent amounts for context state accounts
  const equalityRent = await getContextStateRent(rpcUrl, 'equality');
  const validityType = proofData.hasAuditor ? 'validity3' : 'validity2';
  const validityRent = await getContextStateRent(rpcUrl, validityType);
  const rangeRent = await getContextStateRent(rpcUrl, 'rangeU128');

  const sender = address(senderAddress);
  const feePayerAddress = sender;

  const transactions: {
    name: string;
    compiled: ReturnType<typeof compileTransaction>;
    additionalSigners?: Uint8Array[];
  }[] = [];

  // Split into 5 transactions to fit within wallet's 1232-byte limit
  // Transaction 1: Create + verify equality proof
  const equalityCreateIx = buildCreateAccountInstruction(
    senderAddress,
    equalityContextKeypair.address,
    equalityRent,
    CONTEXT_STATE_SIZES.equality,
    ZK_PROOF_PROGRAM_ID
  );
  const equalityVerifyIx = buildVerifyProofWithContextInstruction(
    'equality',
    proofData.equalityProofData,
    equalityContextKeypair.address,
    senderAddress
  );

  const equalityTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([equalityCreateIx, equalityVerifyIx], m),
  );

  transactions.push({
    name: 'Create & verify equality proof',
    compiled: compileTransaction(equalityTxMessage),
    additionalSigners: [equalityContextKeypair.secretKey],
  });

  // Transaction 2: Create + verify validity proof
  const validityCreateIx = buildCreateAccountInstruction(
    senderAddress,
    validityContextKeypair.address,
    validityRent,
    CONTEXT_STATE_SIZES[validityType],
    ZK_PROOF_PROGRAM_ID
  );
  const validityVerifyIx = buildVerifyProofWithContextInstruction(
    validityType,
    proofData.validityProofData,
    validityContextKeypair.address,
    senderAddress
  );

  const validityTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([validityCreateIx, validityVerifyIx], m),
  );

  transactions.push({
    name: 'Create & verify validity proof',
    compiled: compileTransaction(validityTxMessage),
    additionalSigners: [validityContextKeypair.secretKey],
  });

  // Transaction 3: Create range context
  const rangeCreateIx = buildCreateAccountInstruction(
    senderAddress,
    rangeContextKeypair.address,
    rangeRent,
    CONTEXT_STATE_SIZES.rangeU128,
    ZK_PROOF_PROGRAM_ID
  );

  const rangeCreateTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([rangeCreateIx], m),
  );

  transactions.push({
    name: 'Create range context',
    compiled: compileTransaction(rangeCreateTxMessage),
    additionalSigners: [rangeContextKeypair.secretKey],
  });

  // Transaction 4: Verify range proof
  const rangeVerifyIx = buildVerifyProofWithContextInstruction(
    'rangeU128',
    proofData.rangeProofData,
    rangeContextKeypair.address,
    senderAddress
  );

  const rangeVerifyTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([rangeVerifyIx], m),
  );

  transactions.push({
    name: 'Verify range proof',
    compiled: compileTransaction(rangeVerifyTxMessage),
  });

  // Transaction 5: Execute transfer + close all context accounts
  const transferIx = buildTransferWithContextInstruction(
    senderTokenAccountAddress,
    recipientTokenAccountAddress,
    mintAddress,
    senderAddress,
    newDecryptableBalance,
    equalityContextKeypair.address,
    validityContextKeypair.address,
    rangeContextKeypair.address,
    proofData.encryptedAmountLo,
    proofData.encryptedAmountHi
  );

  const closeEqualityIx = buildCloseContextStateInstruction(
    equalityContextKeypair.address,
    senderAddress,
    senderAddress
  );
  const closeValidityIx = buildCloseContextStateInstruction(
    validityContextKeypair.address,
    senderAddress,
    senderAddress
  );
  const closeRangeIx = buildCloseContextStateInstruction(
    rangeContextKeypair.address,
    senderAddress,
    senderAddress
  );

  const transferAndCloseTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([
      transferIx,
      closeEqualityIx, closeValidityIx, closeRangeIx
    ], m),
  );

  transactions.push({
    name: 'Execute transfer & close contexts',
    compiled: compileTransaction(transferAndCloseTxMessage),
  });

  return { proofData, transactions };
}

/**
 * Builds a complete confidential transfer transaction with all ZK proofs.
 */
export async function buildConfidentialTransferTransaction(
  senderTokenAccountAddress: string,
  recipientTokenAccountAddress: string,
  mintAddress: string,
  senderAddress: string,
  transferAmount: bigint,
  senderKeypair: unknown,
  senderAeKey: unknown,
  senderCurrentBalance: bigint,
  recipientElGamalPubkeyBytes: Uint8Array,
  recentBlockhash: string,
  lastValidBlockHeight: bigint,
  auditorElGamalPubkeyBytes?: Uint8Array
): Promise<ReturnType<typeof compileTransaction>> {
  const sdk = await getZkSdk();

  const senderTokenAccount = address(senderTokenAccountAddress);
  const recipientTokenAccount = address(recipientTokenAccountAddress);
  const mint = address(mintAddress);
  const sender = address(senderAddress);

  // Generate all the proof data
  const {
    equalityProofData,
    validityProofData,
    rangeProofData,
    encryptedAmountLo,
    encryptedAmountHi,
  } = await generateTransferProofData(
    senderKeypair,
    senderCurrentBalance,
    transferAmount,
    recipientElGamalPubkeyBytes,
    auditorElGamalPubkeyBytes
  );

  // Calculate new decryptable balance
  const newBalance = senderCurrentBalance - transferAmount;
  const newDecryptableBalance = await createDecryptableBalance(senderAeKey, newBalance);

  // Build the ZK proof instructions
  // Equality proof instruction
  const equalityProofInstructionData = new Uint8Array(1 + equalityProofData.length);
  equalityProofInstructionData[0] = 1; // VerifyCiphertextCommitmentEquality
  equalityProofInstructionData.set(equalityProofData, 1);

  const equalityProofInstruction: Instruction = {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [],
    data: equalityProofInstructionData,
  };

  // Validity proof instruction (discriminator depends on 2 or 3 handles)
  const hasAuditor = auditorElGamalPubkeyBytes && auditorElGamalPubkeyBytes.length > 0;
  const validityProofInstructionData = new Uint8Array(1 + validityProofData.length);
  validityProofInstructionData[0] = hasAuditor ? 8 : 7; // 7 = BatchedGrouped2Handles, 8 = BatchedGrouped3Handles
  validityProofInstructionData.set(validityProofData, 1);

  const validityProofInstruction: Instruction = {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [],
    data: validityProofInstructionData,
  };

  // Range proof instruction
  const rangeProofInstructionData = new Uint8Array(1 + rangeProofData.length);
  rangeProofInstructionData[0] = 11; // VerifyBatchedRangeProofU128
  rangeProofInstructionData.set(rangeProofData, 1);

  const rangeProofInstruction: Instruction = {
    programAddress: ZK_PROOF_PROGRAM_ID,
    accounts: [],
    data: rangeProofInstructionData,
  };

  // Build the transfer instruction
  // The proof instructions come before the transfer, so offset is negative
  const transferInstructionData = buildTransferInstructionDataInline(newDecryptableBalance, -3); // 3 proofs before

  // For the transfer instruction, we need to include the encrypted amounts in the accounts
  // Actually, the transfer instruction has a more complex format with ciphertext data embedded
  // Let me simplify - for now, build a basic transfer instruction

  const transferInstruction: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ID,
    accounts: [
      { address: senderTokenAccount, role: 1 }, // WRITABLE - source
      { address: mint, role: 0 }, // READONLY - mint
      { address: recipientTokenAccount, role: 1 }, // WRITABLE - destination
      { address: SYSVAR_INSTRUCTIONS_ID, role: 0 }, // READONLY - sysvar instructions
      { address: sender, role: 2 }, // READONLY_SIGNER - authority
    ],
    data: transferInstructionData,
  };

  const feePayerAddress = address(senderAddress);

  // Order: proof instructions first, then transfer (which references them with negative offset)
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayerAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(recentBlockhash), lastValidBlockHeight },
      m
    ),
    (m) => appendTransactionMessageInstructions([
      equalityProofInstruction,
      validityProofInstruction,
      rangeProofInstruction,
      transferInstruction,
    ], m),
  );

  return compileTransaction(transactionMessage);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Fetches the ElGamal public key from a token account's confidential transfer extension.
 */
export function parseElGamalPubkeyFromAccountInfo(
  ctAccountState: { elgamalPubkey: string }
): Uint8Array {
  // The elgamalPubkey is base64 encoded
  const base64 = ctAccountState.elgamalPubkey;
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decrypts a confidential balance using the ElGamal secret key.
 * NOTE: This only works for small values (< 2^32) due to brute-force discrete log.
 * For larger balances, use decryptDecryptableBalance with AES key instead.
 */
export async function decryptBalance(
  secretKeyBytes: Uint8Array,
  encryptedBalanceBase64: string
): Promise<bigint | null> {
  const sdk = await getZkSdk();

  // Decode the base64 encrypted balance
  const binaryString = atob(encryptedBalanceBase64);
  const encryptedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    encryptedBytes[i] = binaryString.charCodeAt(i);
  }

  // Check if it's all zeros (empty balance)
  if (encryptedBytes.every(b => b === 0)) {
    return 0n;
  }

  try {
    const secretKey = sdk.ElGamalSecretKey.fromBytes(secretKeyBytes);
    const ciphertext = sdk.ElGamalCiphertext.fromBytes(encryptedBytes);

    if (!ciphertext) {
      return null;
    }

    const amount = secretKey.decrypt(ciphertext);

    // Handle undefined or null return from SDK
    if (amount === undefined || amount === null) {
      return null;
    }

    return amount;
  } catch (err) {
    console.error('decryptBalance: error during decryption:', err);
    return null;
  }
}

/**
 * Decrypts the decryptableAvailableBalance using AES key.
 * This is the correct way to decrypt large confidential balances.
 * Format: 36 bytes = AES ciphertext that decrypts to the balance.
 */
export async function decryptDecryptableBalance(
  aeKey: unknown,
  decryptableBalanceBase64: string
): Promise<bigint | null> {
  const sdk = await getZkSdk();

  // Decode the base64 encrypted balance
  const binaryString = atob(decryptableBalanceBase64);
  const encryptedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    encryptedBytes[i] = binaryString.charCodeAt(i);
  }

  console.log('decryptDecryptableBalance: encryptedBytes length:', encryptedBytes.length);

  // Check if it's all zeros (empty balance)
  if (encryptedBytes.every(b => b === 0)) {
    console.log('decryptDecryptableBalance: all zeros, returning 0');
    return 0n;
  }

  try {
    const key = aeKey as InstanceType<typeof sdk.AeKey>;

    // Create AeCiphertext from bytes
    const ciphertext = sdk.AeCiphertext.fromBytes(encryptedBytes);
    console.log('decryptDecryptableBalance: ciphertext created:', !!ciphertext);

    if (!ciphertext) {
      console.log('decryptDecryptableBalance: failed to parse ciphertext');
      return null;
    }

    // Decrypt using AE key
    const amount = key.decrypt(ciphertext);
    console.log('decryptDecryptableBalance: decrypted amount:', amount, typeof amount);

    if (amount === undefined || amount === null) {
      console.log('decryptDecryptableBalance: decrypt returned undefined/null');
      return null;
    }

    return amount;
  } catch (err) {
    console.error('decryptDecryptableBalance: error during decryption:', err);
    return null;
  }
}

/**
 * Decrypts the pending balance from pendingBalanceLo and pendingBalanceHi.
 * The pending balance is split: total = lo + (hi << 16)
 */
export async function decryptPendingBalance(
  secretKeyBytes: Uint8Array,
  pendingBalanceLoBase64: string,
  pendingBalanceHiBase64: string
): Promise<bigint | null> {
  const sdk = await getZkSdk();

  // Helper to decode base64 to bytes
  const decodeBase64 = (base64: string): Uint8Array => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const loBytes = decodeBase64(pendingBalanceLoBase64);
  const hiBytes = decodeBase64(pendingBalanceHiBase64);

  // Check if both are all zeros (no pending balance)
  if (loBytes.every(b => b === 0) && hiBytes.every(b => b === 0)) {
    return 0n;
  }

  const secretKey = sdk.ElGamalSecretKey.fromBytes(secretKeyBytes);

  try {
    let lo = 0n;
    let hi = 0n;

    // Decrypt lo if not all zeros
    if (!loBytes.every(b => b === 0)) {
      const loCiphertext = sdk.ElGamalCiphertext.fromBytes(loBytes);
      if (loCiphertext) {
        lo = secretKey.decrypt(loCiphertext) ?? 0n;
      }
    }

    // Decrypt hi if not all zeros
    if (!hiBytes.every(b => b === 0)) {
      const hiCiphertext = sdk.ElGamalCiphertext.fromBytes(hiBytes);
      if (hiCiphertext) {
        hi = secretKey.decrypt(hiCiphertext) ?? 0n;
      }
    }

    // Combine: total = lo + (hi << 16)
    const total = lo + (hi << 16n);
    return total;
  } catch (err) {
    console.error('Failed to decrypt pending balance:', err);
    return null;
  }
}

// Helper functions

function decodeBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [];

  for (const char of str) {
    let carry = ALPHABET.indexOf(char);
    if (carry < 0) throw new Error(`Invalid base58 character: ${char}`);

    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  // Count leading zeros
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros++;
  }

  // Convert bytes to a big integer
  let num = 0n;
  for (const byte of bytes) {
    num = (num << 8n) | BigInt(byte);
  }

  // Convert to base58
  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = ALPHABET[remainder] + result;
  }

  // Add leading '1's for leading zeros
  return '1'.repeat(leadingZeros) + result;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

function numberToLEBytes(num: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let n = num;
  for (let i = 0; i < length; i++) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}
