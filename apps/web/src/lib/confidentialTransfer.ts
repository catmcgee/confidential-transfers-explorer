/**
 * Confidential Transfer operations for Token-2022.
 *
 * Built on the official confidential-transfer helpers from
 * `@solana-program/token-2022/confidential` (instruction plans that handle
 * the multi-transaction context-state proof flow required on devnet) and
 * `@solana/zk-sdk` for ElGamal/AES cryptography.
 */

import {
  address,
  createSignableMessage,
  createTransactionMessage,
  createTransactionPlanExecutor,
  createTransactionPlanner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  isSolanaError,
  isTransactionSendingSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__INSTRUCTION_PLANS__FAILED_TO_EXECUTE_TRANSACTION_PLAN,
  type Address,
  type Instruction,
  type InstructionPlan,
  type MessagePartialSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit';
import {
  fetchMint,
  fetchToken,
  getConfidentialDepositInstruction,
} from '@solana-program/token-2022';

// The ZK SDK and the confidential helpers load WebAssembly, so they are
// imported dynamically (Next.js webpack handles the WASM at bundle time).
let zkSdk: typeof import('@solana/zk-sdk/bundler') | null = null;

export async function getZkSdk() {
  if (!zkSdk) {
    zkSdk = await import('@solana/zk-sdk/bundler');
  }
  return zkSdk;
}

let ctHelpers: typeof import('@solana-program/token-2022/confidential') | null = null;

async function getCtHelpers() {
  if (!ctHelpers) {
    ctHelpers = await import('@solana-program/token-2022/confidential');
  }
  return ctHelpers;
}

// Instance types for ZK SDK classes (vs the class constructor types)
type ZkSdk = Awaited<ReturnType<typeof getZkSdk>>;
export type ElGamalKeypairInstance = InstanceType<ZkSdk['ElGamalKeypair']>;
export type ElGamalSecretKeyInstance = InstanceType<ZkSdk['ElGamalSecretKey']>;
export type AeKeyInstance = InstanceType<ZkSdk['AeKey']>;

export type CtRpc = Rpc<SolanaRpcApi>;

// =============================================================================
// Utility Functions
// =============================================================================

function decodeBase64(str: string): Uint8Array {
  const binaryStr = atob(str);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

// =============================================================================
// Key Derivation
// =============================================================================

export interface CtKeys {
  elgamalKeypair: ElGamalKeypairInstance;
  elgamalSecretKey: ElGamalSecretKeyInstance;
  aesKey: AeKeyInstance;
  elgamalPubkeyBytes: Uint8Array;
}

async function signSeedText(signer: MessagePartialSigner, text: string): Promise<Uint8Array> {
  const [dictionary] = await signer.signMessages([
    createSignableMessage(new TextEncoder().encode(text)),
  ]);
  const signature = dictionary?.[signer.address];
  if (!signature) {
    throw new Error('Wallet returned no signature for key derivation');
  }
  return new Uint8Array(signature);
}

/**
 * Derives the ElGamal keypair and AES key for an `(owner, mint)` pair from
 * wallet signatures: the signer signs a deterministic, domain-separated
 * message and the Ed25519 signature seeds the key (via the ZK SDK's
 * `fromSignature`).
 *
 * The signed messages are human-readable UTF-8 text
 * (`ElGamalSecretKey:<owner>:<mint>`) rather than the raw-byte message the
 * token-2022 helpers use — Phantom refuses to sign opaque binary payloads
 * that could conceal a transaction ("You cannot sign solana transactions
 * using sign message"), and readable text is also better wallet UX.
 *
 * The keys are bound to owner+mint, so they remain stable if the token
 * account is closed and reopened, and re-derivable on any device with the
 * same wallet.
 */
export async function deriveCtKeys(
  signer: MessagePartialSigner,
  ownerAddress: string,
  mintAddress: string
): Promise<CtKeys> {
  const zk = await getZkSdk();

  const owner = address(ownerAddress);
  const mint = address(mintAddress);

  const elgamalSignature = await signSeedText(signer, `ElGamalSecretKey:${owner}:${mint}`);
  const elgamalKeypair = zk.ElGamalKeypair.fromSignature(elgamalSignature);
  const elgamalSecretKey = elgamalKeypair.secret();

  const aeSignature = await signSeedText(signer, `AeKey:${owner}:${mint}`);
  const aesKey = zk.AeKey.fromSignature(aeSignature);

  return {
    elgamalKeypair,
    elgamalSecretKey,
    aesKey,
    elgamalPubkeyBytes: elgamalKeypair.pubkey().toBytes(),
  };
}

// =============================================================================
// Balance Encryption / Decryption
// =============================================================================

export async function encryptBalance(aesKey: AeKeyInstance, amount: bigint): Promise<Uint8Array> {
  return aesKey.encrypt(amount).toBytes();
}

export async function decryptAeBalance(
  aesKey: AeKeyInstance,
  ciphertextBytes: Uint8Array
): Promise<bigint | null> {
  const zk = await getZkSdk();
  const ciphertext = zk.AeCiphertext.fromBytes(ciphertextBytes);
  if (!ciphertext) return null;
  try {
    return aesKey.decrypt(ciphertext) ?? null;
  } catch {
    return null;
  }
}

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

export function parseElGamalPubkeyFromAccountInfo(ctAccountState: {
  elgamalPubkey: string;
}): Uint8Array {
  return decodeBase64(ctAccountState.elgamalPubkey);
}

// =============================================================================
// Instruction Plans (multi-transaction flows)
// =============================================================================

/**
 * Plan that creates the ATA (if needed), reallocates it for the
 * confidential-transfer extension, configures the account, and verifies the
 * ZK pubkey-validity proof.
 */
export async function createConfigureAccountPlan(input: {
  rpc: CtRpc;
  payer: TransactionSigner;
  owner: Address | TransactionSigner;
  mintAddress: string;
  tokenAccountAddress?: string;
  keys: CtKeys;
}): Promise<InstructionPlan> {
  const helpers = await getCtHelpers();
  return helpers.getCreateConfidentialTransferAccountInstructionPlan({
    payer: input.payer,
    owner: input.owner,
    mint: address(input.mintAddress),
    token: input.tokenAccountAddress ? address(input.tokenAccountAddress) : undefined,
    rpc: input.rpc,
    elgamalKeypair: input.keys.elgamalKeypair,
    aesKey: input.keys.aesKey,
  });
}

/**
 * Instruction that moves tokens from the public balance into the
 * confidential pending balance.
 */
export function createDepositInstruction(input: {
  tokenAccountAddress: string;
  mintAddress: string;
  authority: Address | TransactionSigner;
  amount: bigint;
  decimals: number;
}): Instruction {
  return getConfidentialDepositInstruction({
    token: address(input.tokenAccountAddress),
    mint: address(input.mintAddress),
    authority: input.authority,
    amount: input.amount,
    decimals: input.decimals,
  });
}

/**
 * Instruction that applies the pending balance to the available balance.
 * Fetches the token account, decrypts the pending balance locally, and
 * re-encrypts the new decryptable available balance.
 */
export async function createApplyPendingBalanceInstruction(input: {
  rpc: CtRpc;
  tokenAccountAddress: string;
  authority: Address | TransactionSigner;
  keys: CtKeys;
}): Promise<Instruction> {
  const helpers = await getCtHelpers();
  const token = address(input.tokenAccountAddress);
  const tokenAccount = await fetchToken(input.rpc, token);
  return helpers.getApplyConfidentialPendingBalanceInstructionFromToken({
    token,
    tokenAccount: tokenAccount.data,
    authority: input.authority,
    elgamalSecretKey: input.keys.elgamalSecretKey,
    aesKey: input.keys.aesKey,
  });
}

/**
 * Plan that confidentially transfers tokens between two accounts.
 *
 * The helper splits the amount into lo/hi halves, generates the three
 * required ZK proofs (equality, grouped-ciphertext validity, batched range),
 * verifies each into a context-state account across multiple transactions,
 * executes the transfer, and closes the context-state accounts — the flow
 * required on devnet where all proofs cannot fit in one transaction.
 */
export async function createTransferPlan(input: {
  rpc: CtRpc;
  payer: TransactionSigner;
  sourceTokenAccountAddress: string;
  destinationTokenAccountAddress: string;
  mintAddress: string;
  authority: Address | TransactionSigner;
  amount: bigint;
  keys: CtKeys;
}): Promise<InstructionPlan> {
  const helpers = await getCtHelpers();
  const sourceToken = address(input.sourceTokenAccountAddress);
  const destinationToken = address(input.destinationTokenAccountAddress);

  const [sourceTokenAccount, destinationTokenAccount] = await Promise.all([
    fetchToken(input.rpc, sourceToken),
    fetchToken(input.rpc, destinationToken),
  ]);

  return helpers.getConfidentialTransferInstructionPlan({
    sourceToken,
    mint: address(input.mintAddress),
    destinationToken,
    sourceTokenAccount: sourceTokenAccount.data,
    destinationTokenAccount: destinationTokenAccount.data,
    authority: input.authority,
    amount: input.amount,
    sourceElgamalKeypair: input.keys.elgamalKeypair,
    aesKey: input.keys.aesKey,
    proofMode: 'context-state',
    payer: input.payer,
    rpc: input.rpc,
  });
}

/**
 * Plan that withdraws tokens from the confidential available balance back
 * to the public balance (equality + range proofs via context-state accounts).
 */
export async function createWithdrawPlan(input: {
  rpc: CtRpc;
  payer: TransactionSigner;
  tokenAccountAddress: string;
  mintAddress: string;
  authority: Address | TransactionSigner;
  amount: bigint;
  keys: CtKeys;
}): Promise<InstructionPlan> {
  const helpers = await getCtHelpers();
  const token = address(input.tokenAccountAddress);
  const mint = address(input.mintAddress);

  const [tokenAccount, mintAccount] = await Promise.all([
    fetchToken(input.rpc, token),
    fetchMint(input.rpc, mint),
  ]);

  return helpers.getConfidentialWithdrawInstructionPlan({
    token,
    mint,
    tokenAccount: tokenAccount.data,
    authority: input.authority,
    amount: input.amount,
    decimals: mintAccount.data.decimals,
    elgamalKeypair: input.keys.elgamalKeypair,
    aesKey: input.keys.aesKey,
    proofMode: 'context-state',
    payer: input.payer,
    rpc: input.rpc,
  });
}

// =============================================================================
// Plan Execution
// =============================================================================

const CONFIRM_POLL_INTERVAL_MS = 1_500;
const CONFIRM_TIMEOUT_MS = 60_000;

async function confirmSignature(rpc: CtRpc, signature: Signature): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for confirmation of ${signature}`);
}

export interface ExecutePlanResult {
  signatures: Signature[];
}

/**
 * Collects human-readable failure messages (including program logs) from an
 * error and everything reachable through it — cause chains, and the
 * `transactionPlanResult` tree that kit's plan executor attaches to its
 * generic "plan failed to execute" error.
 */
function collectFailureMessages(root: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (node instanceof Error) {
      if (node.message && !messages.includes(node.message)) {
        messages.push(node.message);
      }
      const context = (node as { context?: unknown }).context;
      if (context && typeof context === 'object') {
        const logs = (context as { logs?: unknown }).logs;
        if (Array.isArray(logs)) {
          const interesting = logs
            .filter((line): line is string => typeof line === 'string')
            .filter((line) => /error|failed|panicked/i.test(line))
            .slice(-3);
          for (const line of interesting) {
            if (!messages.includes(line)) messages.push(line);
          }
        }
        visit(context);
      }
      visit(node.cause);
      return;
    }

    const record = node as Record<string, unknown>;
    if (record.kind === 'failed' && record.error) {
      visit(record.error);
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value);
    }
  };

  visit(root);
  return messages;
}

/**
 * Plans and executes an instruction plan, sending each transaction
 * sequentially and waiting for confirmation between them.
 *
 * The fee payer may be a wallet-backed `TransactionSendingSigner` (the
 * wallet signs and submits) or a regular keypair signer (the transaction is
 * fully signed locally and submitted through the RPC).
 */
export async function executeInstructionPlan(input: {
  plan: InstructionPlan;
  rpc: CtRpc;
  feePayer: TransactionSigner;
  onProgress?: (info: { signature: Signature; index: number }) => void;
}): Promise<ExecutePlanResult> {
  const { plan, rpc, feePayer, onProgress } = input;
  const base58Decoder = getBase58Decoder();

  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m)
      ),
  });

  const transactionPlan = await planner(plan);

  const signatures: Signature[] = [];
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (context, message) => {
      const { value: latestBlockhash } = await rpc
        .getLatestBlockhash({ commitment: 'confirmed' })
        .send();
      const messageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        message
      );

      let signature: Signature;
      if (isTransactionSendingSigner(feePayer)) {
        const signatureBytes = await signAndSendTransactionMessageWithSigners(
          messageWithLifetime
        );
        signature = base58Decoder.decode(signatureBytes) as Signature;
      } else {
        const signedTransaction = await signTransactionMessageWithSigners(messageWithLifetime);
        const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
        signature = await rpc
          .sendTransaction(wireTransaction, {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          })
          .send();
      }

      await confirmSignature(rpc, signature);
      signatures.push(signature);
      onProgress?.({ signature, index: signatures.length - 1 });
      return signature;
    },
  });

  try {
    await executor(transactionPlan);
  } catch (error) {
    if (
      isSolanaError(error, SOLANA_ERROR__INSTRUCTION_PLANS__FAILED_TO_EXECUTE_TRANSACTION_PLAN)
    ) {
      // Unwrap the generic "plan failed" wrapper: the real failure (and any
      // program logs) lives inside the attached transactionPlanResult.
      console.error('Transaction plan failed:', error.context);
      const details = collectFailureMessages([error.context, error.cause]).filter(
        (message) => !message.startsWith('The provided transaction plan failed')
      );
      if (details.length > 0) {
        throw new Error(details.join(' — '));
      }
    }
    throw error;
  }
  return { signatures };
}
