// Token-2022 Program ID
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Confidential Transfer Extension discriminators
export const CT_INSTRUCTION_DISCRIMINATORS = {
  // ConfidentialTransfer extension instructions
  InitializeMint: 0,
  UpdateMint: 1,
  ConfigureAccount: 2,
  ApproveAccount: 3,
  EmptyAccount: 4,
  Deposit: 5,
  Withdraw: 6,
  Transfer: 7,
  ApplyPendingBalance: 8,
  EnableConfidentialCredits: 9,
  DisableConfidentialCredits: 10,
  EnableNonConfidentialCredits: 11,
  DisableNonConfidentialCredits: 12,
  TransferWithSplitProofs: 13,
  TransferWithFee: 14,
} as const;

// Reverse lookup for instruction names
export const CT_INSTRUCTION_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(CT_INSTRUCTION_DISCRIMINATORS).map(([name, disc]) => [disc, name])
);

// Extension type discriminator for Confidential Transfer
export const CONFIDENTIAL_TRANSFER_EXTENSION_TYPE = 10;

// ZK ElGamal Proof Program
export const ZK_ELGAMAL_PROOF_PROGRAM_ID = 'ZkE1Gama1Proof11111111111111111111111111111';

// All CT instruction types we track
export const TRACKED_CT_TYPES = [
  'InitializeMint',
  'UpdateMint',
  'ConfigureAccount',
  'ApproveAccount',
  'EmptyAccount',
  'Deposit',
  'Withdraw',
  'Transfer',
  'ApplyPendingBalance',
  'EnableConfidentialCredits',
  'DisableConfidentialCredits',
  'EnableNonConfidentialCredits',
  'DisableNonConfidentialCredits',
  'TransferWithSplitProofs',
  'TransferWithFee',
] as const;

export type TrackedCTType = (typeof TRACKED_CT_TYPES)[number];
