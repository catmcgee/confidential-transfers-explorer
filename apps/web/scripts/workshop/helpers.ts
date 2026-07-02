/**
 * helpers.ts — plumbing shared by the numbered workshop steps.
 *
 * This file is intentionally NOT the interesting part of the workshop.
 * It contains the boring-but-necessary machinery: RPC setup, loading a
 * funded payer, sending transactions with HTTP-polling confirmation,
 * a tiny JSON state store so each numbered step can pick up where the
 * previous one left off, and the decrypt utilities.
 *
 * Skim it once; spend your attention on 01–05 instead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionPlanner,
  type TransactionPlanExecutor,
  type InstructionPlan,
  createSignableMessage,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  createTransactionPlanner,
  createTransactionPlanExecutor,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  singleInstructionPlan,
} from '@solana/kit';
// IMPORTANT: import WASM classes from '/bundler' — the same entry point the
// confidential helpers use internally — so objects cross the WASM boundary as
// the same class instances. Node needs NODE_OPTIONS=--experimental-wasm-modules.
import { AeCiphertext, AeKey, ElGamalCiphertext, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';

// ---------------------------------------------------------------------------
// RPC + constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ENV_PATH = resolve(HERE, '../../.env'); // apps/web/.env

export function readEnvVar(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const content = readFileSync(WEB_ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && match[1] === name) return match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — fall through */
  }
  return undefined;
}

export const RPC_URL = readEnvVar('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com';
export const rpc = createSolanaRpc(RPC_URL);

export const DECIMALS = 9;
export const RAW = (uiAmount: number | bigint) => BigInt(uiAmount) * 10n ** BigInt(DECIMALS);
export const ui = (raw: bigint) => {
  const whole = raw / RAW(1);
  const frac = raw % RAW(1);
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(DECIMALS, '0').replace(/0+$/, '')}`;
};

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;

const TX_DELAY_MS = 750; // be gentle with devnet RPCs

// ---------------------------------------------------------------------------
// Payer loading / funding
// ---------------------------------------------------------------------------

export async function signerFromPrivateKeyString(raw: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  if (raw.trim().startsWith('[')) bytes = new Uint8Array(JSON.parse(raw));
  else bytes = new Uint8Array(getBase58Encoder().encode(raw.trim()));
  if (bytes.length === 64) return await createKeyPairSignerFromBytes(bytes);
  if (bytes.length === 32) return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  throw new Error(`Unsupported private key length: ${bytes.length} (expected 32 or 64 bytes)`);
}

/** Fresh owner whose 32-byte seed we keep, so later steps can re-create the signer. */
export async function newOwner(): Promise<{ signer: KeyPairSigner; secretBase58: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return { signer, secretBase58: getBase58Decoder().decode(seed) };
}

async function requestAirdropWithRetry(addr: Address, sol: number, attempts = 3): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const sig = await rpc.requestAirdrop(addr, lamports(BigInt(sol) * 1_000_000_000n)).send();
      console.log(`  airdrop requested: ${explorerTx(sig)}`);
      await confirmSignature(sig);
      return true;
    } catch (err) {
      console.warn(`  airdrop attempt ${i}/${attempts} failed: ${(err as Error).message}`);
      if (i < attempts) await sleep(3000);
    }
  }
  return false;
}

/** Load FAUCET_PRIVATE_KEY from apps/web/.env (base58 or JSON array), or airdrop into an ephemeral key. */
export async function loadPayer(minLamports = 100_000_000n): Promise<KeyPairSigner> {
  const envKey = readEnvVar('FAUCET_PRIVATE_KEY');
  let payer: KeyPairSigner;
  if (envKey) {
    payer = await signerFromPrivateKeyString(envKey);
  } else {
    payer = (await newOwner()).signer;
    console.log(`No FAUCET_PRIVATE_KEY found; generated ephemeral payer ${payer.address}, requesting airdrop...`);
    await requestAirdropWithRetry(payer.address, 2);
  }
  let { value: balance } = await rpc.getBalance(payer.address).send();
  if (BigInt(balance) < minLamports) {
    console.log('Payer balance low, attempting airdrop...');
    await requestAirdropWithRetry(payer.address, 2);
    balance = (await rpc.getBalance(payer.address).send()).value;
  }
  if (BigInt(balance) < minLamports) {
    throw new Error(
      `Payer ${payer.address} has ${Number(balance) / 1e9} SOL (need >= ${Number(minLamports) / 1e9}). ` +
        'Fund it via https://faucet.solana.com or set FAUCET_PRIVATE_KEY in apps/web/.env.',
    );
  }
  console.log(`Payer: ${payer.address} (${Number(balance) / 1e9} SOL)`);
  return payer;
}

// ---------------------------------------------------------------------------
// Transaction sending (HTTP polling, no websockets) + human-readable labels
// ---------------------------------------------------------------------------

export async function confirmSignature(signature: Signature | string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([signature as Signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out waiting for confirmation of ${signature}`);
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ZK_PROOF_PROGRAM = 'ZkE1Gama1Proof11111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const ZK_IX: Record<number, string> = {
  0: 'ZK proof program: close context-state account (rent refunded to payer)',
  3: 'ZK proof program: verify EQUALITY proof (new source balance matches its commitment)',
  4: 'ZK proof program: verify PUBKEY VALIDITY proof (ElGamal pubkey is well-formed)',
  6: 'ZK proof program: verify batched RANGE proof, u64 (no negative amounts)',
  7: 'ZK proof program: verify batched RANGE proof, u128 (amounts + remaining balance in range)',
  12: 'ZK proof program: verify batched CIPHERTEXT VALIDITY proof (amount encrypted for sender/receiver/auditor)',
};
const CT_IX: Record<number, string> = {
  0: 'Token-2022: initialize ConfidentialTransferMint extension',
  2: 'Token-2022: configure confidential account (stores ElGamal pubkey on-chain)',
  5: 'Token-2022: confidential DEPOSIT (public balance -> encrypted pending)',
  6: 'Token-2022: confidential WITHDRAW (encrypted available -> public)',
  7: 'Token-2022: confidential TRANSFER (checks the 3 proof context accounts)',
  8: 'Token-2022: apply pending balance (fold pending into available)',
};

/** Best-effort one-line description of an instruction, for read-aloud narration. */
export function describeInstruction(ix: Instruction): string {
  const program = ix.programAddress as string;
  const d = ix.data ? new Uint8Array(ix.data) : new Uint8Array();
  if (program === SYSTEM_PROGRAM) {
    const kind = d.length >= 4 ? d[0] : -1;
    if (kind === 0) return 'System program: create account (allocate + fund a new account)';
    if (kind === 2) return 'System program: transfer SOL';
    return 'System program instruction';
  }
  if (program === ZK_PROOF_PROGRAM) return ZK_IX[d[0]] ?? `ZK proof program instruction (${d[0]})`;
  if (program === TOKEN_2022) {
    if (d[0] === 27) return CT_IX[d[1]] ?? `Token-2022 confidential-transfer instruction (${d[1]})`;
    if (d[0] === 0) return 'Token-2022: initialize mint';
    if (d[0] === 7) return 'Token-2022: mint tokens (public)';
    if (d[0] === 12) return 'Token-2022: transfer tokens (public, amounts visible)';
    if (d[0] === 29) return 'Token-2022: reallocate token account (make room for the CT extension)';
    return `Token-2022 instruction (${d[0]})`;
  }
  if (program === ATA_PROGRAM) return 'ATA program: create associated token account';
  return `instruction for program ${program}`;
}

export type Tools = { planner: TransactionPlanner; executor: TransactionPlanExecutor };

/** Planner + executor that narrate every transaction they send (instructions + explorer link). */
export function createTools(payer: KeyPairSigner): Tools {
  let txCount = 0;
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayerSigner(payer, m)),
  });
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_context, transactionMessage) => {
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const withLifetime = setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, transactionMessage);
      const transaction = await signTransactionMessageWithSigners(withLifetime);
      const signature = getSignatureFromTransaction(transaction);
      txCount += 1;
      // Print the whole block in ONE console.log: some plans execute
      // transactions in parallel, and interleaved lines are unreadable.
      const block = [
        `\n  Transaction ${txCount}:`,
        ...transactionMessage.instructions.map(ix => `    - ${describeInstruction(ix)}`),
        `    ${explorerTx(signature)}`,
      ];
      await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64' }).send();
      console.log(block.join('\n'));
      await confirmSignature(signature);
      await sleep(TX_DELAY_MS);
      return transaction;
    },
  });
  return { planner, executor };
}

export async function executePlan(tools: Tools, plan: InstructionPlan): Promise<void> {
  await tools.executor(await tools.planner(plan));
}

export async function executeInstructions(tools: Tools, instructions: Instruction[]): Promise<void> {
  for (const ix of instructions) await executePlan(tools, singleInstructionPlan(ix));
}

// ---------------------------------------------------------------------------
// Confidential-transfer key derivation (matches the web app!)
// ---------------------------------------------------------------------------

export type CtKeys = {
  elgamalKeypair: ElGamalKeypair;
  elgamalSecretKey: ElGamalSecretKey;
  aesKey: AeKey;
};

/**
 * Derive the ElGamal keypair + AES key from SIGNATURES over human-readable
 * text messages. This EXACTLY matches apps/web/src/lib/confidentialTransfer.ts
 * (deriveCtKeys), so a wallet used here derives the same keys in the web app.
 *
 * Why readable text instead of an opaque binary payload? Wallets like Phantom
 * refuse to sign arbitrary binary blobs via signMessage (they can't show the
 * user what they're approving). A deterministic, human-readable message like
 * "ElGamalSecretKey:<owner>:<mint>" is wallet-friendly AND still yields a
 * stable 64-byte Ed25519 signature we can stretch into encryption keys.
 * Nothing is ever stored: sign the same text again, get the same keys back.
 */
export async function deriveCtKeys(signer: KeyPairSigner, mint: Address): Promise<CtKeys> {
  const signText = async (text: string): Promise<Uint8Array> => {
    const [dictionary] = await signer.signMessages([createSignableMessage(new TextEncoder().encode(text))]);
    const signature = dictionary?.[signer.address];
    if (!signature) throw new Error('No signature produced');
    return new Uint8Array(signature);
  };
  const elgamalKeypair = ElGamalKeypair.fromSignature(await signText(`ElGamalSecretKey:${signer.address}:${mint}`));
  const aesKey = AeKey.fromSignature(await signText(`AeKey:${signer.address}:${mint}`));
  return { elgamalKeypair, elgamalSecretKey: elgamalKeypair.secret(), aesKey };
}

// ---------------------------------------------------------------------------
// State store — lets each numbered step load what previous steps created
// ---------------------------------------------------------------------------

const STATE_PATH = resolve(HERE, 'state.json');

export type OwnerState = { name: string; address: string; secretBase58: string; tokenAccount: string };
export type WorkshopState = {
  mint?: string;
  mintAuthority?: string;
  decimals?: number;
  alice?: OwnerState;
  bob?: OwnerState;
};

export function readState(): WorkshopState {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as WorkshopState;
}

export function writeState(patch: Partial<WorkshopState>): void {
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`\nState saved to ${STATE_PATH}`);
}

export function requireState<K extends keyof WorkshopState>(key: K, producedBy: string): NonNullable<WorkshopState[K]> {
  const value = readState()[key];
  if (value === undefined) throw new Error(`state.json is missing "${key}" — run ${producedBy} first.`);
  return value as NonNullable<WorkshopState[K]>;
}

// ---------------------------------------------------------------------------
// Decrypt utilities
// ---------------------------------------------------------------------------

export type CtAccountState = {
  elgamalPubkey: string;
  pendingBalanceLow: Uint8Array;
  pendingBalanceHigh: Uint8Array;
  availableBalance: Uint8Array;
  decryptableAvailableBalance: Uint8Array;
  pendingBalanceCreditCounter: bigint;
};

/** Pull the ConfidentialTransferAccount extension out of a fetched token account. */
export function getCtExtension(tokenData: {
  extensions: { __option: 'Some' | 'None'; value?: readonly { __kind: string }[] };
}): CtAccountState {
  const extensions = tokenData.extensions.__option === 'Some' ? tokenData.extensions.value! : [];
  const ct = extensions.find(e => e.__kind === 'ConfidentialTransferAccount');
  if (!ct) throw new Error('Token account has no ConfidentialTransferAccount extension');
  return ct as unknown as CtAccountState;
}

/**
 * Decrypt the PENDING balance with the ElGamal secret key. The pending balance
 * is stored as TWO ciphertexts — the low 16 bits and the high bits of the
 * amount — because ElGamal decryption is a brute-force discrete-log search
 * that is only tractable for small exponents. total = lo + (hi << 16).
 */
export function decryptPending(ct: CtAccountState, elgamalSecretKey: ElGamalSecretKey): bigint {
  const decrypt = (bytes: Uint8Array): bigint => {
    const ciphertext = ElGamalCiphertext.fromBytes(new Uint8Array(bytes));
    if (!ciphertext) throw new Error('Could not parse ElGamal ciphertext');
    return elgamalSecretKey.decrypt(ciphertext);
  };
  const lo = decrypt(ct.pendingBalanceLow);
  const hi = decrypt(ct.pendingBalanceHigh);
  return lo + (hi << 16n);
}

/**
 * Decrypt the AVAILABLE balance with the AES key. Unlike ElGamal, the AES
 * "decryptable available balance" decrypts instantly to the full 64-bit
 * amount — it exists exactly so the owner never needs a slow ElGamal decrypt
 * of their own running balance.
 */
export function decryptAvailable(ct: CtAccountState, aesKey: AeKey): bigint {
  const ciphertext = AeCiphertext.fromBytes(new Uint8Array(ct.decryptableAvailableBalance));
  if (!ciphertext) throw new Error('Could not parse AE ciphertext');
  return aesKey.decrypt(ciphertext);
}

export const toBase64 = (bytes: Uint8Array | ArrayLike<number>): string =>
  Buffer.from(new Uint8Array(bytes)).toString('base64');
