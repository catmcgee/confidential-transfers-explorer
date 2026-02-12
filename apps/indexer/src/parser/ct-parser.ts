import { TOKEN_2022_PROGRAM_ID, CT_INSTRUCTION_NAMES, type TrackedCTType } from '@ct-explorer/shared';
import type { CTActivityRecord } from '@ct-explorer/shared';

// Confidential Transfer extension discriminator in Token-2022
// When the first byte is 27, it's a Confidential Transfer instruction
const CONFIDENTIAL_TRANSFER_DISCRIMINATOR = 27;

/**
 * Parsed confidential transfer instruction
 */
export interface ParsedCTInstruction {
  type: TrackedCTType | 'Unknown';
  mint: string | null;
  sourceOwner: string | null;
  destOwner: string | null;
  sourceTokenAccount: string | null;
  destTokenAccount: string | null;
  ciphertextLo: string | null;
  ciphertextHi: string | null;
  publicAmount: string | null;
  instructionData: string;
}

/**
 * Check if an instruction is a Token-2022 Confidential Transfer instruction
 */
export function isCTInstruction(programId: string, data: Uint8Array): boolean {
  if (programId !== TOKEN_2022_PROGRAM_ID) {
    return false;
  }

  // Confidential Transfer instructions start with discriminator 27
  if (data.length < 2) {
    return false;
  }

  const firstByte = data[0];

  // Check if it's a confidential transfer instruction (first byte = 27)
  return firstByte === CONFIDENTIAL_TRANSFER_DISCRIMINATOR;
}

/**
 * Parse the CT instruction type from instruction data
 */
export function parseCTInstructionType(data: Uint8Array): TrackedCTType | 'Unknown' {
  if (data.length < 2) {
    return 'Unknown';
  }

  // The CT instruction type is the second byte (index 1)
  // Format: [27 (CT discriminator), instruction_type, ...data]
  const ctInstructionType = data[1]!;

  // Map instruction discriminator to type name
  const typeName = CT_INSTRUCTION_NAMES[ctInstructionType];

  // Return the type name if it exists, otherwise Unknown
  if (typeName) {
    return typeName as TrackedCTType;
  }

  return 'Unknown';
}

/**
 * Extract ciphertext data from instruction based on type
 * Returns base64-encoded ciphertexts if found
 */
export function extractCiphertexts(
  type: TrackedCTType | 'Unknown',
  data: Uint8Array
): { ciphertextLo: string | null; ciphertextHi: string | null } {
  // Ciphertext extraction depends on instruction type
  // ElGamal ciphertexts are 64 bytes each (32 bytes for each component)
  // Header is 2 bytes: [27 (CT discriminator), instruction_type]

  if (type === 'Transfer' || type === 'TransferWithSplitProofs' || type === 'TransferWithFee') {
    // Transfer instructions have ciphertexts after the header
    // Layout varies, but typically starts after 2 bytes of header
    if (data.length >= 130) { // 2 (header) + 64 (lo) + 64 (hi)
      const loStart = 2;
      const hiStart = 66;

      // Only extract if we have enough data and it looks like valid ciphertext
      if (data.length >= hiStart + 64) {
        const ciphertextLo = Buffer.from(data.slice(loStart, loStart + 64)).toString('base64');
        const ciphertextHi = Buffer.from(data.slice(hiStart, hiStart + 64)).toString('base64');
        return { ciphertextLo, ciphertextHi };
      }
    }
  }

  return { ciphertextLo: null, ciphertextHi: null };
}

/**
 * Extract public amount from deposit/withdraw instructions
 */
export function extractPublicAmount(
  type: TrackedCTType | 'Unknown',
  data: Uint8Array
): string | null {
  if (type === 'Deposit' || type === 'Withdraw') {
    // Amount is typically a u64 after the 2-byte header
    // Format: [27, instruction_type, amount (8 bytes), decimals (1 byte)]
    if (data.length >= 10) {
      const amountBytes = data.slice(2, 10);
      // Read as little-endian u64
      const amount = Buffer.from(amountBytes).readBigUInt64LE();
      return amount.toString();
    }
  }
  return null;
}

/**
 * Parse accounts from instruction based on type
 */
export function parseAccounts(
  type: TrackedCTType | 'Unknown',
  accounts: string[]
): {
  sourceTokenAccount: string | null;
  destTokenAccount: string | null;
  sourceOwner: string | null;
  destOwner: string | null;
  mint: string | null;
} {
  // Default result
  const result = {
    sourceTokenAccount: null as string | null,
    destTokenAccount: null as string | null,
    sourceOwner: null as string | null,
    destOwner: null as string | null,
    mint: null as string | null,
  };

  if (accounts.length === 0) {
    return result;
  }

  // Account layouts vary by instruction type
  // These are approximations based on Token-2022 CT instruction layouts

  switch (type) {
    case 'Transfer':
    case 'TransferWithSplitProofs':
    case 'TransferWithFee':
      // Transfer: [source_token, mint, dest_token, owner, ...]
      // OR with split proofs context accounts:
      // [source_token, mint, dest_token, equality_ctx, validity_ctx, range_ctx, sysvar, owner]
      if (accounts.length >= 8) {
        // Transfer with context accounts (split proofs)
        result.sourceTokenAccount = accounts[0] ?? null;
        result.mint = accounts[1] ?? null;
        result.destTokenAccount = accounts[2] ?? null;
        result.sourceOwner = accounts[7] ?? null; // Owner is at index 7
      } else if (accounts.length >= 4) {
        // Standard transfer
        result.sourceTokenAccount = accounts[0] ?? null;
        result.mint = accounts[1] ?? null;
        result.destTokenAccount = accounts[2] ?? null;
        result.sourceOwner = accounts[3] ?? null;
      }
      break;

    case 'Deposit':
      // Deposit: [token_account, mint, owner, ...]
      if (accounts.length >= 3) {
        result.destTokenAccount = accounts[0] ?? null;
        result.mint = accounts[1] ?? null;
        result.sourceOwner = accounts[2] ?? null;
        result.destOwner = accounts[2] ?? null;
      }
      break;

    case 'Withdraw':
      // Withdraw: [token_account, mint, owner, ...]
      if (accounts.length >= 3) {
        result.sourceTokenAccount = accounts[0] ?? null;
        result.mint = accounts[1] ?? null;
        result.sourceOwner = accounts[2] ?? null;
        result.destOwner = accounts[2] ?? null;
      }
      break;

    case 'ApplyPendingBalance':
      // ApplyPendingBalance: [token_account, owner, ...]
      if (accounts.length >= 2) {
        result.sourceTokenAccount = accounts[0] ?? null;
        result.destTokenAccount = accounts[0] ?? null;
        result.sourceOwner = accounts[1] ?? null;
        result.destOwner = accounts[1] ?? null;
      }
      break;

    case 'ConfigureAccount':
    case 'ApproveAccount':
    case 'EmptyAccount':
    case 'EnableConfidentialCredits':
    case 'DisableConfidentialCredits':
    case 'EnableNonConfidentialCredits':
    case 'DisableNonConfidentialCredits':
      // Account operations: [token_account, mint, owner, ...]
      if (accounts.length >= 3) {
        result.sourceTokenAccount = accounts[0] ?? null;
        result.destTokenAccount = accounts[0] ?? null;
        result.mint = accounts[1] ?? null;
        result.sourceOwner = accounts[2] ?? null;
        result.destOwner = accounts[2] ?? null;
      }
      break;

    case 'InitializeMint':
    case 'UpdateMint':
      // Mint operations: [mint, ...]
      if (accounts.length >= 1) {
        result.mint = accounts[0] ?? null;
      }
      break;

    default:
      // Unknown - try to extract what we can
      if (accounts.length >= 1) {
        result.sourceTokenAccount = accounts[0] ?? null;
      }
      if (accounts.length >= 2) {
        result.mint = accounts[1] ?? null;
      }
      if (accounts.length >= 3) {
        result.sourceOwner = accounts[2] ?? null;
      }
      break;
  }

  return result;
}

/**
 * Parse a CT instruction from transaction data
 */
export function parseCTInstruction(
  programId: string,
  data: Uint8Array,
  accounts: string[]
): ParsedCTInstruction | null {
  if (!isCTInstruction(programId, data)) {
    return null;
  }

  const type = parseCTInstructionType(data);
  const { ciphertextLo, ciphertextHi } = extractCiphertexts(type, data);
  const publicAmount = extractPublicAmount(type, data);
  const parsedAccounts = parseAccounts(type, accounts);

  return {
    type,
    ...parsedAccounts,
    ciphertextLo,
    ciphertextHi,
    publicAmount,
    instructionData: Buffer.from(data).toString('base64'),
  };
}

/**
 * Convert parsed instruction to activity record (without signature/slot/blockTime)
 */
export function toActivityRecord(
  parsed: ParsedCTInstruction,
  signature: string,
  slot: number,
  blockTime: number | null
): Omit<CTActivityRecord, 'id' | 'createdAt'> {
  return {
    signature,
    slot,
    blockTime,
    instructionType: parsed.type,
    mint: parsed.mint,
    sourceOwner: parsed.sourceOwner,
    destOwner: parsed.destOwner,
    sourceTokenAccount: parsed.sourceTokenAccount,
    destTokenAccount: parsed.destTokenAccount,
    ciphertextLo: parsed.ciphertextLo,
    ciphertextHi: parsed.ciphertextHi,
    publicAmount: parsed.publicAmount,
    instructionData: parsed.instructionData,
  };
}
