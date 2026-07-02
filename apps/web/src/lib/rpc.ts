import {
  TOKEN_2022_PROGRAM_ID,
  ZK_ELGAMAL_PROOF_PROGRAM_ID,
  type CTActivityResponse,
  type MintInfo,
  type RawInstructionSummary,
  type TransactionDetailResponse,
  type UserTokenAccountInfo,
} from '@ct-explorer/shared';

// Server-side RPC. Prefers the private SOLANA_RPC_URL (e.g. a keyed Helius
// endpoint set only in the server environment — never exposed to the
// browser), falling back to the public endpoint.
const RPC_URL =
  process.env['SOLANA_RPC_URL'] ||
  process.env['NEXT_PUBLIC_SOLANA_RPC_URL'] ||
  'https://api.devnet.solana.com';

const cache = new Map<string, { data: unknown; expiry: number }>();

const PAGE_TTL = 30_000;
const TX_TTL = 5 * 60_000;
const TX_ERROR_TTL = 10_000;
const MINT_TTL = 10 * 60_000;
const BALANCE_TTL = 30_000;
const RPC_TIMEOUT_MS = 8_000;
const RPC_RETRIES = 1;
const MAX_SIGNATURE_SCAN_ROUNDS = 8;
// Hard wall-clock budget for a single activity scan. Serverless functions
// have tight execution limits, and public RPCs rate-limit aggressively —
// when the budget runs out we return what we have with a cursor so the
// client can keep paginating.
const SCAN_TIME_BUDGET_MS = 6_000;

const PARSED_TYPE_MAP: Record<string, string> = {
  confidentialTransfer: 'Transfer',
  confidentialTransferWithSplitProofs: 'TransferWithSplitProofs',
  confidentialTransferWithFee: 'TransferWithFee',
  deposit: 'Deposit',
  depositConfidentialTransfer: 'Deposit',
  withdraw: 'Withdraw',
  withdrawConfidentialTransfer: 'Withdraw',
  applyPendingBalance: 'ApplyPendingBalance',
  applyPendingConfidentialTransferBalance: 'ApplyPendingBalance',
  configureConfidentialTransferAccount: 'ConfigureAccount',
  approveConfidentialTransferAccount: 'ApproveAccount',
  emptyConfidentialTransferAccount: 'EmptyAccount',
  enableConfidentialCredits: 'EnableConfidentialCredits',
  disableConfidentialCredits: 'DisableConfidentialCredits',
  enableNonConfidentialCredits: 'EnableNonConfidentialCredits',
  disableNonConfidentialCredits: 'DisableNonConfidentialCredits',
  initializeConfidentialTransferMint: 'InitializeMint',
  updateConfidentialTransferMint: 'UpdateMint',
  harvestWithheldConfidentialTransferTokensToMint: 'HarvestWithheldTokens',
  initializeConfidentialMintBurnMint: 'InitializeMint',
};

const INSTRUCTION_PRIORITY = [
  'Transfer',
  'TransferWithSplitProofs',
  'TransferWithFee',
  'Deposit',
  'Withdraw',
  'ApplyPendingBalance',
  'ConfigureAccount',
  'ApproveAccount',
  'EmptyAccount',
  'EnableConfidentialCredits',
  'DisableConfidentialCredits',
  'EnableNonConfidentialCredits',
  'DisableNonConfidentialCredits',
  'InitializeMint',
  'UpdateMint',
  'HarvestWithheldTokens',
];

interface RpcSignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

interface RpcAccountKey {
  pubkey?: string;
}

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
}

interface RpcInstruction {
  programId?: string;
  accounts?: Array<string | number>;
  data?: string;
  parsed?: unknown;
}

interface RpcInnerInstructionGroup {
  instructions?: RpcInstruction[];
}

interface RpcTransactionData {
  slot?: number;
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
    innerInstructions?: RpcInnerInstructionGroup[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | RpcAccountKey>;
      instructions?: RpcInstruction[];
    };
  };
}

interface RpcMintAccountInfoResult {
  value: {
    data?: {
      parsed?: {
        info?: Record<string, unknown>;
      };
    };
  } | null;
}

interface RpcTokenAccountsByOwnerResult {
  value: Array<{
    pubkey: string;
    account: {
      data?: {
        parsed?: {
          info?: Record<string, unknown>;
        };
      };
    };
  }>;
}

interface ActivityPageResult {
  activities: CTActivityResponse[];
  cursor: string | null;
  hasMore: boolean;
}

interface NormalizedInstruction {
  programId: string;
  accounts: string[];
  data: string | null;
  parsedType: string | null;
  parsedInfo: Record<string, unknown> | null;
}

interface ActivityScanConfig {
  signatureBatchSize: number;
  txBatchSize: number;
  maxRounds: number;
}

interface ActivityCursorState {
  before: string | null;
  carryover: CTActivityResponse[];
}

const SIGNATURE_CURSOR_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function cacheSet(key: string, data: unknown, ttlMs: number) {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [cacheKey, entry] of cache) {
      if (now > entry.expiry) cache.delete(cacheKey);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeCursor(state: ActivityCursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): ActivityCursorState | null {
  if (!cursor) return null;
  if (SIGNATURE_CURSOR_PATTERN.test(cursor)) {
    return { before: cursor, carryover: [] };
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed)) return null;

    const before = typeof parsed.before === 'string' ? parsed.before : null;
    const carryoverRaw = Array.isArray(parsed.carryover) ? parsed.carryover : [];
    const carryover = carryoverRaw.filter(isRecord).map((activity) => activity as unknown as CTActivityResponse);

    return { before, carryover };
  } catch {
    return null;
  }
}

function getActivityScanConfig(address: string, limit: number): ActivityScanConfig {
  if (address === ZK_ELGAMAL_PROOF_PROGRAM_ID || address === TOKEN_2022_PROGRAM_ID) {
    // Keep cold scans well under serverless function timeouts: fewer rounds
    // per request, with pagination (cursor / "Load more") covering depth.
    return {
      signatureBatchSize: Math.min(Math.max(limit * 2, 10), 25),
      txBatchSize: 5,
      maxRounds: Math.min(Math.max(Math.ceil(limit / 2), 3), 6),
    };
  }

  return {
    signatureBatchSize: Math.min(Math.max(limit * 2, 10), 50),
    txBatchSize: 3,
    maxRounds: MAX_SIGNATURE_SCAN_ROUNDS,
  };
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RPC_RETRIES; attempt++) {
    try {
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`RPC ${method} failed with HTTP ${response.status}: ${text.slice(0, 160)}`);
      }

      let payload: { result?: T; error?: { message?: string } };
      try {
        payload = JSON.parse(text) as { result?: T; error?: { message?: string } };
      } catch {
        throw new Error(`RPC ${method} returned non-JSON data: ${text.slice(0, 160)}`);
      }

      if (payload.error) {
        throw new Error(payload.error.message ?? `RPC ${method} failed`);
      }

      return payload.result as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < RPC_RETRIES) {
        await delay(300 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError ?? new Error(`RPC ${method} failed`);
}

function getTimestamp(blockTime: number | null | undefined): string | null {
  return typeof blockTime === 'number' ? new Date(blockTime * 1000).toISOString() : null;
}

function getAccountKeys(txData: RpcTransactionData): string[] {
  return (txData.transaction?.message?.accountKeys ?? []).map((accountKey) =>
    typeof accountKey === 'string' ? accountKey : accountKey.pubkey ?? ''
  );
}

function buildOwnerAndMintMaps(txData: RpcTransactionData, accountKeys: string[]) {
  const ownerMap = new Map<string, string>();
  const mintMap = new Map<string, string>();

  const balances = [
    ...(txData.meta?.preTokenBalances ?? []),
    ...(txData.meta?.postTokenBalances ?? []),
  ];

  for (const balance of balances) {
    const account = accountKeys[balance.accountIndex];
    if (!account) continue;
    if (balance.owner) ownerMap.set(account, balance.owner);
    if (balance.mint) mintMap.set(account, balance.mint);
  }

  return { ownerMap, mintMap };
}

function normalizeInstruction(ix: RpcInstruction, accountKeys: string[]): NormalizedInstruction | null {
  if (typeof ix.programId !== 'string' || ix.programId.length === 0) return null;

  const parsed = isRecord(ix.parsed) ? ix.parsed : null;
  const parsedInfo = isRecord(parsed?.['info']) ? (parsed['info'] as Record<string, unknown>) : null;
  const parsedType = typeof parsed?.['type'] === 'string' ? (parsed['type'] as string) : null;

  return {
    programId: ix.programId,
    accounts: (ix.accounts ?? []).map((account) =>
      typeof account === 'number' ? accountKeys[account] ?? '' : account
    ),
    data: typeof ix.data === 'string' ? ix.data : null,
    parsedType,
    parsedInfo,
  };
}

function getAllInstructions(txData: RpcTransactionData): NormalizedInstruction[] {
  const accountKeys = getAccountKeys(txData);
  const instructions: NormalizedInstruction[] = [];

  for (const ix of txData.transaction?.message?.instructions ?? []) {
    const normalized = normalizeInstruction(ix, accountKeys);
    if (normalized) instructions.push(normalized);
  }

  for (const group of txData.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      const normalized = normalizeInstruction(ix, accountKeys);
      if (normalized) instructions.push(normalized);
    }
  }

  return instructions;
}

function inferInstructionFields(
  instructionType: string,
  info: Record<string, unknown> | null,
  ownerMap: Map<string, string>,
  mintMap: Map<string, string>
) {
  let sourceTokenAccount = readString(info, 'source') ?? null;
  let destTokenAccount = readString(info, 'destination') ?? null;
  let sourceOwner = readString(info, 'sourceOwner')
    ?? readString(info, 'owner')
    ?? readString(info, 'authority');
  let destOwner = readString(info, 'destinationOwner') ?? null;
  let mint = readString(info, 'mint') ?? null;

  switch (instructionType) {
    case 'Deposit':
      destTokenAccount = readString(info, 'account') ?? destTokenAccount;
      sourceTokenAccount = null;
      destOwner = destOwner ?? sourceOwner;
      break;
    case 'Withdraw':
      sourceTokenAccount = readString(info, 'account') ?? sourceTokenAccount;
      destOwner = destOwner ?? sourceOwner;
      break;
    case 'ApplyPendingBalance':
    case 'ConfigureAccount':
    case 'ApproveAccount':
    case 'EmptyAccount':
    case 'EnableConfidentialCredits':
    case 'DisableConfidentialCredits':
    case 'EnableNonConfidentialCredits':
    case 'DisableNonConfidentialCredits':
      sourceTokenAccount = readString(info, 'account') ?? sourceTokenAccount;
      destTokenAccount = sourceTokenAccount;
      destOwner = destOwner ?? sourceOwner;
      break;
    case 'InitializeMint':
    case 'UpdateMint':
      sourceTokenAccount = null;
      destTokenAccount = null;
      mint = readString(info, 'mint') ?? readString(info, 'account') ?? mint;
      break;
    default:
      break;
  }

  if (!mint && sourceTokenAccount) mint = mintMap.get(sourceTokenAccount) ?? null;
  if (!mint && destTokenAccount) mint = mintMap.get(destTokenAccount) ?? null;

  if (!sourceOwner && sourceTokenAccount) sourceOwner = ownerMap.get(sourceTokenAccount) ?? null;
  if (!destOwner && destTokenAccount) destOwner = ownerMap.get(destTokenAccount) ?? null;

  if (!sourceOwner && sourceTokenAccount && sourceTokenAccount === destTokenAccount) {
    sourceOwner = destOwner;
  }
  if (!destOwner && destTokenAccount && destTokenAccount === sourceTokenAccount) {
    destOwner = sourceOwner;
  }

  return {
    sourceTokenAccount,
    destTokenAccount,
    sourceOwner,
    destOwner,
    mint,
  };
}

/**
 * Parse a raw RPC transaction into CTActivityResponse entries.
 */
export function parseTransactionActivities(sig: string, txData: RpcTransactionData): CTActivityResponse[] {
  if (txData.meta?.err) return [];

  const slot = txData.slot ?? 0;
  const blockTime = txData.blockTime ?? null;
  const timestamp = getTimestamp(blockTime);
  const accountKeys = getAccountKeys(txData);
  const { ownerMap, mintMap } = buildOwnerAndMintMaps(txData, accountKeys);

  const activities: CTActivityResponse[] = [];
  let idCounter = 1;

  for (const instruction of getAllInstructions(txData)) {
    if (instruction.programId !== TOKEN_2022_PROGRAM_ID) continue;
    if (!instruction.parsedType) continue;

    const instructionType = PARSED_TYPE_MAP[instruction.parsedType];
    if (!instructionType) continue;

    const info = instruction.parsedInfo;
    const { sourceTokenAccount, destTokenAccount, sourceOwner, destOwner, mint } =
      inferInstructionFields(instructionType, info, ownerMap, mintMap);

    const publicAmount = readString(info, 'amount');

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
      amount:
        instructionType === 'Deposit' || instructionType === 'Withdraw'
          ? publicAmount ?? 'confidential'
          : 'confidential',
      ciphertextLo: null,
      ciphertextHi: null,
    });
  }

  return activities;
}

function extractRawInstructions(txData: RpcTransactionData): RawInstructionSummary[] {
  return getAllInstructions(txData)
    .filter((instruction) => instruction.programId === TOKEN_2022_PROGRAM_ID && instruction.data)
    .map((instruction) => ({
      programId: instruction.programId,
      data: instruction.data ?? '',
      accounts: instruction.accounts.filter((account) => account.length > 0),
    }));
}

export async function fetchTransactionDetailFromRpc(
  sig: string
): Promise<TransactionDetailResponse | null> {
  const cacheKey = `tx-detail:${sig}`;
  const cached = cacheGet<TransactionDetailResponse | null>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const txData = await rpcCall<RpcTransactionData | null>('getTransaction', [
      sig,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);

    if (!txData) {
      cacheSet(cacheKey, null, PAGE_TTL);
      return null;
    }

    const activities = parseTransactionActivities(sig, txData);
    const detail: TransactionDetailResponse = {
      signature: sig,
      slot: txData.slot ?? 0,
      blockTime: txData.blockTime ?? null,
      timestamp: getTimestamp(txData.blockTime),
      activities,
      rawInstructions: extractRawInstructions(txData),
    };

    cacheSet(cacheKey, detail, TX_TTL);
    return detail;
  } catch (error) {
    console.error('[RPC] fetchTransactionDetail error:', error);
    cacheSet(cacheKey, null, TX_ERROR_TTL);
    return null;
  }
}

/**
 * Fetch a single transaction from RPC and parse CT activities.
 */
export async function fetchTransactionFromRpc(sig: string): Promise<CTActivityResponse[]> {
  const detail = await fetchTransactionDetailFromRpc(sig);
  return detail?.activities ?? [];
}

function activityMatchesType(activity: CTActivityResponse, type: string): boolean {
  return type === 'all' || activity.instructionType === type;
}

function getInstructionPriority(type: string): number {
  const index = INSTRUCTION_PRIORITY.indexOf(type);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function selectPrimaryActivity(
  activities: CTActivityResponse[],
  type: string
): CTActivityResponse | null {
  const filtered = type === 'all'
    ? activities
    : activities.filter((activity) => activityMatchesType(activity, type));

  if (filtered.length === 0) return null;

  return filtered.reduce((best, activity) => {
    if (best === null) return activity;
    return getInstructionPriority(activity.instructionType) < getInstructionPriority(best.instructionType)
      ? activity
      : best;
  }, null as CTActivityResponse | null);
}

async function fetchPrimaryActivityForSignature(
  signature: string,
  type: string
): Promise<CTActivityResponse | null> {
  const detail = await fetchTransactionDetailFromRpc(signature);
  if (!detail) return null;
  return selectPrimaryActivity(detail.activities, type);
}

export async function fetchActivityPageFromRpc(
  address: string,
  limit: number = 50,
  cursor: string | null = null,
  type: string = 'all'
): Promise<ActivityPageResult> {
  const cacheKey = `activity-page:${address}:${type}:${cursor ?? 'start'}:${limit}`;
  const cached = cacheGet<ActivityPageResult>(cacheKey);
  if (cached) return cached;

  try {
    const cursorState = decodeCursor(cursor);
    const collected: CTActivityResponse[] = [...(cursorState?.carryover ?? [])];
    let before = cursorState?.before ?? (cursor && SIGNATURE_CURSOR_PATTERN.test(cursor) ? cursor : undefined);
    let rounds = 0;
    let exhausted = false;
    let hadError = false;
    let lastScannedSignature: string | null = before ?? null;
    const { signatureBatchSize, txBatchSize, maxRounds } = getActivityScanConfig(address, limit);
    const scanDeadline = Date.now() + SCAN_TIME_BUDGET_MS;
    let budgetExceeded = false;

    while (collected.length < limit + 1 && rounds < maxRounds) {
      if (Date.now() >= scanDeadline) {
        budgetExceeded = true;
        break;
      }
      let signatures: RpcSignatureInfo[];
      try {
        signatures = await rpcCall<RpcSignatureInfo[]>('getSignaturesForAddress', [
          address,
          {
            limit: signatureBatchSize,
            ...(before ? { before } : {}),
          },
        ]);
      } catch (error) {
        console.error('[RPC] fetchActivityPage signatures error:', error);
        hadError = true;
        break;
      }

      rounds += 1;
      if (signatures.length === 0) {
        exhausted = true;
        break;
      }

      for (
        let batchStart = 0;
        batchStart < signatures.length && collected.length < limit + 1;
        batchStart += txBatchSize
      ) {
        if (Date.now() >= scanDeadline) {
          budgetExceeded = true;
          break;
        }

        const batch = signatures.slice(batchStart, batchStart + txBatchSize);
        const results = await Promise.all(
          batch.map(async (signatureInfo) => {
            if (signatureInfo.err) return null;
            return fetchPrimaryActivityForSignature(signatureInfo.signature, type);
          })
        );

        for (const activity of results) {
          if (!activity) continue;
          collected.push(activity);
          if (collected.length >= limit + 1) break;
        }

        // Track the last fully processed signature so the cursor resumes
        // exactly where a budget-limited scan left off.
        lastScannedSignature = batch[batch.length - 1]?.signature ?? lastScannedSignature;
      }

      if (budgetExceeded) break;

      lastScannedSignature = signatures[signatures.length - 1]?.signature ?? lastScannedSignature;
      if (signatures.length < signatureBatchSize) {
        exhausted = true;
        break;
      }
      before = signatures[signatures.length - 1]?.signature;
    }

    const activities = collected.slice(0, limit);
    const carryover = collected.slice(limit);
    const hasMore = carryover.length > 0 || hadError || budgetExceeded || !exhausted;
    const result: ActivityPageResult = {
      activities,
      cursor:
        hasMore && lastScannedSignature
          ? encodeCursor({
              before: lastScannedSignature,
              carryover,
            })
          : null,
      hasMore,
    };

    cacheSet(cacheKey, result, PAGE_TTL);
    return result;
  } catch (error) {
    console.error('[RPC] fetchActivityPage error:', error);
    return {
      activities: [],
      cursor: null,
      hasMore: false,
    };
  }
}

export async function fetchFeedPageFromRpc(
  limit: number = 50,
  cursor: string | null = null,
  type: string = 'all'
): Promise<ActivityPageResult> {
  // Anchor the global feed scan on the ZK ElGamal Proof Program rather than
  // the Token-2022 program. On public clusters the Token-2022 program has
  // enormous unrelated traffic, while the ZK proof program is referenced
  // almost exclusively by confidential-transfer flows (proof verification
  // and context-state closing happen in the same transactions as the
  // transfer/withdraw/configure instructions), so its signature history is
  // a concentrated feed of CT activity.
  return fetchActivityPageFromRpc(ZK_ELGAMAL_PROOF_PROGRAM_ID, limit, cursor, type);
}

/**
 * Backwards-compatible helper for the old no-cursor callers.
 */
export async function fetchActivitiesForAddress(
  address: string,
  limit: number = 50
): Promise<CTActivityResponse[]> {
  const result = await fetchActivityPageFromRpc(address, limit);
  return result.activities;
}

export async function fetchMintInfoFromRpc(address: string): Promise<MintInfo | null> {
  const cacheKey = `mint:${address}`;
  const cached = cacheGet<MintInfo | null>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const accountInfo = await rpcCall<RpcMintAccountInfoResult>('getAccountInfo', [
      address,
      { encoding: 'jsonParsed' },
    ]);

    const parsedInfo = accountInfo.value?.data?.parsed?.info ?? null;
    const decimals = readNumber(parsedInfo ?? null, 'decimals') ?? 9;

    const mintInfo: MintInfo | null = accountInfo.value
      ? {
          address,
          decimals,
          name: readString(parsedInfo ?? null, 'name'),
          symbol: readString(parsedInfo ?? null, 'symbol'),
        }
      : null;

    cacheSet(cacheKey, mintInfo, MINT_TTL);
    return mintInfo;
  } catch (error) {
    console.error('[RPC] fetchMintInfo error:', error);
    return null;
  }
}

export async function fetchRecentMintsFromRpc(limit: number = 50): Promise<MintInfo[]> {
  const cacheKey = `recent-mints:${limit}`;
  const cached = cacheGet<MintInfo[]>(cacheKey);
  if (cached) return cached;

  const feed = await fetchFeedPageFromRpc(Math.min(Math.max(limit, 25), 100), null, 'all');
  const uniqueMints = Array.from(
    new Set(feed.activities.map((activity) => activity.mint).filter((mint): mint is string => Boolean(mint)))
  ).slice(0, limit);

  const mints = (await Promise.all(uniqueMints.map((mint) => fetchMintInfoFromRpc(mint))))
    .filter((mint): mint is MintInfo => mint !== null);

  cacheSet(cacheKey, mints, PAGE_TTL);
  return mints;
}

export async function fetchUserTokenAccountsFromRpc(
  owner: string
): Promise<UserTokenAccountInfo[]> {
  const cacheKey = `balances:${owner}`;
  const cached = cacheGet<UserTokenAccountInfo[]>(cacheKey);
  if (cached) return cached;

  try {
    const result = await rpcCall<RpcTokenAccountsByOwnerResult>('getTokenAccountsByOwner', [
      owner,
      { programId: TOKEN_2022_PROGRAM_ID },
      { encoding: 'jsonParsed' },
    ]);

    const mintSet = new Set<string>();
    for (const item of result.value) {
      const mint = readString(item.account.data?.parsed?.info ?? null, 'mint');
      if (mint) mintSet.add(mint);
    }

    const mintInfoEntries = await Promise.all(
      Array.from(mintSet).map(async (mint) => [mint, await fetchMintInfoFromRpc(mint)] as const)
    );
    const mintInfoMap = new Map(mintInfoEntries);

    const tokenAccounts = result.value.map((item) => {
      const info = item.account.data?.parsed?.info ?? null;
      const mint = readString(info, 'mint') ?? '';
      const tokenAmount = isRecord(info?.['tokenAmount']) ? (info['tokenAmount'] as Record<string, unknown>) : null;
      const mintInfo = mintInfoMap.get(mint) ?? null;

      return {
        address: item.pubkey,
        mint,
        mintDecimals: mintInfo?.decimals ?? readNumber(tokenAmount, 'decimals') ?? 9,
        mintName: mintInfo?.name ?? null,
        mintSymbol: mintInfo?.symbol ?? null,
        pendingBalanceLo: null,
        pendingBalanceHi: null,
        availableBalance: 'encrypted',
        publicBalance: readString(tokenAmount, 'amount'),
      };
    });

    cacheSet(cacheKey, tokenAccounts, BALANCE_TTL);
    return tokenAccounts;
  } catch (error) {
    console.error('[RPC] fetchUserTokenAccounts error:', error);
    return [];
  }
}
