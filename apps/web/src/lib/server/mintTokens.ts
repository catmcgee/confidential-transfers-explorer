/**
 * Server-side minting for the faucet and self-mint API routes.
 *
 * The FAUCET_PRIVATE_KEY wallet is the mint authority of CT_FAUCET_MINT, so
 * instead of transferring from a pre-funded token account, tokens are minted
 * straight to the requester via token-2022's `getMintToATAInstructionPlanAsync`
 * (creates the associated token account idempotently, then mints). A SOL
 * top-up is included when the recipient can't cover transaction fees and
 * proof-account rent.
 */

import bs58 from 'bs58';
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  sequentialInstructionPlan,
  singleInstructionPlan,
  type Address,
  type InstructionPlan,
  type KeyPairSigner,
} from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getMintToATAInstructionPlanAsync,
} from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
import { executeInstructionPlan, type CtRpc } from '@/lib/confidentialTransfer';

export const CT_MINT =
  process.env.CT_FAUCET_MINT || '9bLcAhVjiUZsTdpcg2HtrddiSzuK5uEezAWDi7u1aght';

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  'https://api.devnet.solana.com';

// Top up to 0.1 SOL whenever the recipient holds less than 0.05 — enough for
// the multi-transaction proof flows (rent on proof context accounts is
// refunded when they close).
const SOL_TOP_UP_LAMPORTS = 100_000_000n;
const SOL_LOW_WATER_LAMPORTS = 50_000_000n;

export function getServerRpc(): CtRpc {
  return createSolanaRpc(RPC_URL);
}

/** The faucet/mint-authority signer from FAUCET_PRIVATE_KEY (base58 or JSON array). */
export async function loadMintAuthoritySigner(): Promise<KeyPairSigner> {
  const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY;
  if (!faucetPrivateKey) {
    throw new Error('Faucet not configured (FAUCET_PRIVATE_KEY missing)');
  }
  const secretKey = faucetPrivateKey.startsWith('[')
    ? new Uint8Array(JSON.parse(faucetPrivateKey))
    : bs58.decode(faucetPrivateKey);
  return createKeyPairSignerFromBytes(secretKey);
}

export interface MintTokensResult {
  signature: string;
  tokenAccount: Address;
  decimals: number;
  solToppedUp: boolean;
}

/**
 * Mints `tokens` (whole tokens, pre-decimals) to the recipient's associated
 * token account, creating it if needed, and tops up their SOL when low.
 */
export async function mintTokensTo(input: {
  rpc: CtRpc;
  authority: KeyPairSigner;
  recipient: Address;
  tokens: number;
}): Promise<MintTokensResult> {
  const { rpc, authority, recipient, tokens } = input;
  const mint = address(CT_MINT);

  const mintAccount = await fetchMint(rpc, mint);
  const decimals = mintAccount.data.decimals;
  const mintAuthority = mintAccount.data.mintAuthority;
  if (mintAuthority.__option !== 'Some' || mintAuthority.value !== authority.address) {
    throw new Error('Server wallet is not the mint authority for the configured mint');
  }

  const plans: InstructionPlan[] = [];

  const { value: recipientBalance } = await rpc.getBalance(recipient).send();
  const solToppedUp = recipientBalance < SOL_LOW_WATER_LAMPORTS;
  if (solToppedUp) {
    plans.push(
      singleInstructionPlan(
        getTransferSolInstruction({
          source: authority,
          destination: recipient,
          amount: SOL_TOP_UP_LAMPORTS,
        })
      )
    );
  }

  plans.push(
    await getMintToATAInstructionPlanAsync({
      payer: authority,
      owner: recipient,
      mint,
      mintAuthority: authority,
      amount: BigInt(tokens) * 10n ** BigInt(decimals),
      decimals,
    })
  );

  const plan = plans.length === 1 ? plans[0]! : sequentialInstructionPlan(plans);
  const { signatures } = await executeInstructionPlan({ plan, rpc, feePayer: authority });

  const [tokenAccount] = await findAssociatedTokenPda({
    owner: recipient,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });

  return {
    signature: signatures[signatures.length - 1] ?? '',
    tokenAccount,
    decimals,
    solToppedUp,
  };
}

// Simple in-memory cooldown so a wallet can't hammer the mint endpoints.
const lastRequestAt = new Map<string, number>();

export function checkCooldown(walletAddress: string, cooldownMs: number): number {
  const now = Date.now();
  const last = lastRequestAt.get(walletAddress) ?? 0;
  const waitMs = last + cooldownMs - now;
  return waitMs > 0 ? waitMs : 0;
}

export function markRequest(walletAddress: string): void {
  lastRequestAt.set(walletAddress, Date.now());
}
