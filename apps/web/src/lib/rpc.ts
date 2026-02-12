import type { CTActivityResponse } from '@ct-explorer/shared';

const RPC_URL = process.env['NEXT_PUBLIC_SOLANA_RPC_URL'] || 'https://zk-edge.surfnet.dev:8899';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const CT_INSTRUCTION_NAMES: Record<number, string> = {
  0: 'Configure',
  1: 'Approve',
  2: 'EmptyAccount',
  3: 'Deposit',
  4: 'Withdraw',
  5: 'Transfer',
  6: 'ApplyPendingBalance',
  7: 'EnableConfidentialCredits',
  8: 'DisableConfidentialCredits',
  9: 'EnableNonConfidentialCredits',
  10: 'DisableNonConfidentialCredits',
  11: 'TransferWithSplitProofs',
};

const PARSED_TYPE_MAP: Record<string, string> = {
  confidentialTransfer: 'Transfer',
  confidentialTransferWithSplitProofs: 'Transfer',
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  applyPendingBalance: 'ApplyPendingBalance',
  applyPendingConfidentialTransferBalance: 'ApplyPendingBalance',
  configureConfidentialTransferAccount: 'Configure',
  approveConfidentialTransferAccount: 'Approve',
  emptyConfidentialTransferAccount: 'EmptyAccount',
  enableConfidentialCredits: 'EnableConfidentialCredits',
  disableConfidentialCredits: 'DisableConfidentialCredits',
};

// These are the only parsed types we consider CT-related
const CT_PARSED_TYPES = new Set(Object.keys(PARSED_TYPE_MAP));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpcCall(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

/**
 * Parse a raw RPC transaction into CTActivityResponse entries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseTransactionActivities(sig: string, txData: any): CTActivityResponse[] {
  const slot = txData.slot ?? 0;
  const blockTime = txData.blockTime ?? null;
  const timestamp = blockTime ? new Date(blockTime * 1000).toISOString() : null;

  const accountKeys: string[] = (
    txData.transaction?.message?.accountKeys ?? []
  ).map((k: { pubkey?: string } | string) =>
    typeof k === 'string' ? k : k.pubkey ?? ''
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allInstructions: any[] = [];

  // Outer instructions
  for (const ix of txData.transaction?.message?.instructions ?? []) {
    allInstructions.push({
      programId: ix.programId ?? '',
      accounts: (ix.accounts ?? []).map((a: string | number) =>
        typeof a === 'number' ? accountKeys[a] ?? '' : a
      ),
      data: ix.data,
      parsed: ix.parsed,
    });
  }

  // Inner instructions
  for (const group of txData.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      allInstructions.push({
        programId: ix.programId ?? '',
        accounts: (ix.accounts ?? []).map((a: string | number) =>
          typeof a === 'number' ? accountKeys[a] ?? '' : a
        ),
        data: ix.data,
        parsed: ix.parsed,
      });
    }
  }

  const activities: CTActivityResponse[] = [];
  let idCounter = 1;

  for (const ix of allInstructions) {
    if (ix.programId !== TOKEN_2022_PROGRAM) continue;

    let instructionType = 'Unknown';
    let sourceTokenAccount: string | null = null;
    let mint: string | null = null;
    let destTokenAccount: string | null = null;
    let sourceOwner: string | null = null;
    let destOwner: string | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = ix.parsed as any;
    if (parsed?.type) {
      // Skip non-CT Token-2022 instructions (reallocate, getAccountDataSize, etc.)
      if (!CT_PARSED_TYPES.has(parsed.type)) continue;
      instructionType = PARSED_TYPE_MAP[parsed.type] ?? parsed.type;
      const info = parsed.info ?? {};
      sourceTokenAccount = info.source ?? info.account ?? null;
      mint = info.mint ?? null;
      destTokenAccount = info.destination ?? null;
      sourceOwner = info.owner ?? info.authority ?? null;
    } else {
      // Unparsed Token-2022 instruction — not a recognized CT operation, skip it.
      // (jsonParsed encoding returns raw data in base58 for unrecognized instructions,
      // which means the RPC couldn't identify it as a CT instruction either)
      continue;
    }

    activities.push({
      id: idCounter++,
      signature: sig,
      slot,
      blockTime,
      timestamp,
      instructionType,
      mint,
      sourceOwner,
      destOwner,
      sourceTokenAccount,
      destTokenAccount,
      amount: 'confidential',
      ciphertextLo: null,
      ciphertextHi: null,
    });
  }

  return activities;
}

/**
 * Fetch a single transaction from RPC and parse CT activities.
 */
export async function fetchTransactionFromRpc(sig: string): Promise<CTActivityResponse[]> {
  try {
    const txData = await rpcCall('getTransaction', [
      sig,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!txData) return [];
    return parseTransactionActivities(sig, txData);
  } catch (err) {
    console.error('[RPC] fetchTransaction error:', err);
    return [];
  }
}

/**
 * Fetch recent signatures for an address from RPC, then parse each transaction.
 * Returns CT activities sorted by slot descending.
 */
export async function fetchActivitiesForAddress(
  address: string,
  limit: number = 50
): Promise<CTActivityResponse[]> {
  try {
    // Get recent signatures
    const sigs = await rpcCall('getSignaturesForAddress', [
      address,
      { limit: Math.min(limit * 2, 100) }, // fetch extra since not all may be CT txs
    ]);
    if (!sigs || sigs.length === 0) return [];

    // Fetch transactions in parallel (batch of 10 at a time)
    const allActivities: CTActivityResponse[] = [];
    const seenSigs = new Set<string>();
    const batchSize = 10;

    for (let i = 0; i < sigs.length && allActivities.length < limit; i += batchSize) {
      const batch = sigs.slice(i, i + batchSize);
      const txResults = await Promise.all(
        batch.map((s: { signature: string }) => fetchTransactionFromRpc(s.signature))
      );
      for (const activities of txResults) {
        if (activities.length === 0) continue;
        // Deduplicate: one entry per signature (pick the most relevant CT instruction)
        const sig = activities[0]!.signature;
        if (seenSigs.has(sig)) continue;
        seenSigs.add(sig);
        // Prefer Transfer/Deposit/Withdraw/Configure over other types
        const primary = activities.find((a: CTActivityResponse) =>
          ['Transfer', 'Deposit', 'Withdraw', 'Configure', 'ApplyPendingBalance'].includes(a.instructionType)
        ) ?? activities[0]!;
        allActivities.push(primary);
      }
    }

    // Sort by slot descending and limit
    allActivities.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0));
    return allActivities.slice(0, limit);
  } catch (err) {
    console.error('[RPC] fetchActivitiesForAddress error:', err);
    return [];
  }
}
