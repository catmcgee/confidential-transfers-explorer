import { TOKEN_2022_PROGRAM_ID } from '@ct-explorer/shared';
import type { CTActivityRecord } from '@ct-explorer/shared';
import { parseCTInstruction, toActivityRecord, isCTInstruction } from './ct-parser.js';

// Transaction types from RPC
interface TransactionMeta {
  err: unknown;
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
  };
}

interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

interface MessageV0 {
  accountKeys: string[];
  instructions: CompiledInstruction[];
  addressTableLookups?: unknown[];
}

interface ParsedTransactionMessage {
  accountKeys: Array<string | { pubkey: string }>;
  instructions: CompiledInstruction[];
}

interface TransactionResponse {
  slot: number;
  blockTime: number | null;
  meta: TransactionMeta | null;
  transaction: {
    message: ParsedTransactionMessage | MessageV0;
    signatures: string[];
  };
  version?: 'legacy' | number;
}

/**
 * Extract account keys from transaction message
 */
function getAccountKeys(message: ParsedTransactionMessage | MessageV0): string[] {
  const keys = message.accountKeys;
  return keys.map((k) => {
    if (typeof k === 'string') return k;
    return k.pubkey;
  });
}

/**
 * Build owner map from token balances
 */
function buildOwnerMap(
  preBalances?: TokenBalance[],
  postBalances?: TokenBalance[],
  accountKeys?: string[]
): Map<string, string> {
  const ownerMap = new Map<string, string>();

  const processBalances = (balances: TokenBalance[] | undefined) => {
    if (!balances || !accountKeys) return;
    for (const balance of balances) {
      const accountAddress = accountKeys[balance.accountIndex];
      if (accountAddress && balance.owner) {
        ownerMap.set(accountAddress, balance.owner);
      }
    }
  };

  processBalances(preBalances);
  processBalances(postBalances);

  return ownerMap;
}

/**
 * Parse a transaction and extract CT activities
 */
export function parseTransaction(
  tx: TransactionResponse,
  signature: string
): Omit<CTActivityRecord, 'id' | 'createdAt'>[] {
  const activities: Omit<CTActivityRecord, 'id' | 'createdAt'>[] = [];

  // Skip failed transactions
  if (tx.meta?.err) {
    return activities;
  }

  const message = tx.transaction.message;
  const accountKeys = getAccountKeys(message);
  const instructions = message.instructions;

  // Build owner map from token balances
  const ownerMap = buildOwnerMap(
    tx.meta?.preTokenBalances,
    tx.meta?.postTokenBalances,
    accountKeys
  );

  // Build mint map from token balances
  const mintMap = new Map<string, string>();
  const processBalancesForMint = (balances: TokenBalance[] | undefined) => {
    if (!balances) return;
    for (const balance of balances) {
      const accountAddress = accountKeys[balance.accountIndex];
      if (accountAddress) {
        mintMap.set(accountAddress, balance.mint);
      }
    }
  };
  processBalancesForMint(tx.meta?.preTokenBalances);
  processBalancesForMint(tx.meta?.postTokenBalances);

  // Process each instruction
  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (!programId) continue;

    // Decode instruction data from base58
    let data: Uint8Array;
    try {
      data = decodeBase58(ix.data);
    } catch {
      continue;
    }

    // Check if this is a CT instruction
    if (!isCTInstruction(programId, data)) {
      continue;
    }

    // Get instruction accounts
    const ixAccounts = ix.accounts.map((idx) => accountKeys[idx] ?? '');

    // Parse the CT instruction
    const parsed = parseCTInstruction(programId, data, ixAccounts);
    if (!parsed) continue;

    // Enrich with owner information from token balances
    if (parsed.sourceTokenAccount && !parsed.sourceOwner) {
      parsed.sourceOwner = ownerMap.get(parsed.sourceTokenAccount) ?? null;
    }
    if (parsed.destTokenAccount && !parsed.destOwner) {
      parsed.destOwner = ownerMap.get(parsed.destTokenAccount) ?? null;
    }

    // Enrich with mint information from token balances
    if (!parsed.mint) {
      if (parsed.sourceTokenAccount) {
        parsed.mint = mintMap.get(parsed.sourceTokenAccount) ?? null;
      }
      if (!parsed.mint && parsed.destTokenAccount) {
        parsed.mint = mintMap.get(parsed.destTokenAccount) ?? null;
      }
    }

    activities.push(toActivityRecord(parsed, signature, tx.slot, tx.blockTime));
  }

  return activities;
}

/**
 * Simple base58 decoder
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP.set(BASE58_ALPHABET[i]!, i);
}

function decodeBase58(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  const bytes: number[] = [0];
  for (const char of str) {
    const value = BASE58_MAP.get(char);
    if (value === undefined) {
      throw new Error(`Invalid base58 character: ${char}`);
    }

    let carry = value;
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

  // Handle leading zeros
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

/**
 * Check if a transaction contains any Token-2022 program invocations
 */
export function mightContainCT(accountKeys: string[]): boolean {
  return accountKeys.includes(TOKEN_2022_PROGRAM_ID);
}
