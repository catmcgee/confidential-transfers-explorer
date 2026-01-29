import type { TrackedCTType } from './constants.js';

// Database record types
export interface CTActivityRecord {
  id: number;
  signature: string;
  slot: number;
  blockTime: number | null;
  instructionType: TrackedCTType | 'Unknown';
  mint: string | null;
  sourceOwner: string | null;
  destOwner: string | null;
  sourceTokenAccount: string | null;
  destTokenAccount: string | null;
  // Encrypted amount data (stored as base64)
  ciphertextLo: string | null;
  ciphertextHi: string | null;
  // For deposits/withdrawals, the public amount
  publicAmount: string | null;
  // Raw instruction data for advanced parsing
  instructionData: string | null;
  createdAt: string;
}

export interface TokenAccountRecord {
  address: string;
  mint: string;
  owner: string;
  lastSeenSlot: number;
  createdAt: string;
  updatedAt: string;
}

export interface MintRecord {
  address: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
  lastSeenSlot: number;
  createdAt: string;
}

// API response types
export interface CTActivityResponse {
  id: number;
  signature: string;
  slot: number;
  blockTime: number | null;
  timestamp: string | null;
  instructionType: string;
  mint: string | null;
  sourceOwner: string | null;
  destOwner: string | null;
  sourceTokenAccount: string | null;
  destTokenAccount: string | null;
  amount: 'confidential' | string;
  ciphertextLo: string | null;
  ciphertextHi: string | null;
}

export interface FeedResponse {
  activities: CTActivityResponse[];
  cursor: number | null;
  hasMore: boolean;
}

export interface AddressActivityResponse {
  address: string;
  activities: CTActivityResponse[];
  cursor: number | null;
  hasMore: boolean;
}

export interface TransactionDetailResponse {
  signature: string;
  slot: number;
  blockTime: number | null;
  timestamp: string | null;
  activities: CTActivityResponse[];
  rawInstructions: RawInstructionSummary[];
}

export interface RawInstructionSummary {
  programId: string;
  data: string;
  accounts: string[];
}

export interface MintInfo {
  address: string;
  decimals: number;
  name: string | null;
  symbol: string | null;
}

export interface MintsResponse {
  mints: MintInfo[];
}

// Auth types
export interface AuthPayload {
  publicKey: string;
  timestamp: number;
  message: string;
}

export interface SessionUser {
  publicKey: string;
  exp: number;
}

export interface LoginRequest {
  publicKey: string;
  signature: string;
  message: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
}

// User-specific endpoints
export interface UserActivityResponse {
  publicKey: string;
  activities: CTActivityResponse[];
  cursor: number | null;
  hasMore: boolean;
}

export interface UserBalancesResponse {
  publicKey: string;
  tokenAccounts: UserTokenAccountInfo[];
}

export interface UserTokenAccountInfo {
  address: string;
  mint: string;
  mintDecimals: number;
  mintName: string | null;
  mintSymbol: string | null;
  // These will be 'encrypted' unless decrypted client-side
  pendingBalanceLo: string | null;
  pendingBalanceHi: string | null;
  availableBalance: string | null;
  // Public balance (non-confidential portion)
  publicBalance: string | null;
}

// Client-side decryption types
export interface DecryptionKeyMaterial {
  // The AES key for balance decryption (derived from signature)
  aesKey: Uint8Array;
  // The ElGamal secret key for ciphertext decryption
  elgamalSecretKey: Uint8Array;
}

export interface DecryptedBalance {
  pending: bigint;
  available: bigint;
  public: bigint;
  total: bigint;
}

export interface DecryptedAmount {
  amount: bigint;
  success: boolean;
  error?: string;
}

// Error response
export interface ErrorResponse {
  error: string;
  code?: string;
}
