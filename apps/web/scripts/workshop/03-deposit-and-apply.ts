/**
 * STEP 03 — Mint public tokens to Alice, deposit into her confidential
 *           balance, and apply the pending balance.
 *
 * WHAT THIS TEACHES
 *   A confidential token account has THREE balances:
 *     - PUBLIC:    the normal Token-2022 amount, visible to everyone.
 *     - PENDING:   encrypted; where incoming credits (deposits, transfers)
 *                  land. Others can ADD to it homomorphically.
 *     - AVAILABLE: encrypted; the balance you can actually spend.
 *
 *   Why does PENDING exist at all? Because only the OWNER can re-encrypt
 *   their own running balance: spending requires proving things about your
 *   balance ciphertext, so the ciphertext must not change under your feet
 *   while someone else credits you. Incoming funds therefore accumulate in
 *   pending, and the owner periodically runs ApplyPendingBalance to fold
 *   them into available — decrypting the pending amount locally and writing
 *   a fresh AES-encrypted "decryptable available balance" only they can read.
 *
 * WHAT TO POINT AT
 *   The three balance lines printed after each stage: watch value move
 *   public -> pending -> available. On the explorer, the deposit amount is
 *   still visible (deposits are public!) — confidentiality starts AFTER
 *   tokens are inside the encrypted balances.
 *
 * RUN
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/03-deposit-and-apply.ts
 */
import { address } from '@solana/kit';
import { fetchToken, getConfidentialDepositInstruction, getMintToInstruction } from '@solana-program/token-2022';
import { getApplyConfidentialPendingBalanceInstructionFromToken } from '@solana-program/token-2022/confidential';

import {
  type CtKeys,
  DECIMALS,
  RAW,
  createTools,
  deriveCtKeys,
  decryptAvailable,
  decryptPending,
  executeInstructions,
  getCtExtension,
  loadPayer,
  requireState,
  rpc,
  signerFromPrivateKeyString,
  ui,
} from './helpers.ts';

const MINT_AMOUNT = RAW(1000);
const DEPOSIT_AMOUNT = RAW(500);

async function printBalances(tokenAccount: string, keys: CtKeys, label: string) {
  const token = await fetchToken(rpc, address(tokenAccount), { commitment: 'confirmed' });
  const ct = getCtExtension(token.data);
  console.log(`\n  Alice's three balances ${label}:`);
  console.log(`    public:    ${ui(token.data.amount)} tokens (anyone can read this)`);
  console.log(`    pending:   ${ui(decryptPending(ct, keys.elgamalSecretKey))} tokens (decrypted with her ElGamal key)`);
  console.log(`    available: ${ui(decryptAvailable(ct, keys.aesKey))} tokens (decrypted with her AES key)`);
}

async function main() {
  console.log('STEP 03 — deposit into the confidential balance and apply pending (devnet)\n');

  const mint = address(requireState('mint', '01-create-mint.ts'));
  const alice = requireState('alice', '02-configure-account.ts');
  const payer = await loadPayer();
  const tools = createTools(payer);

  const aliceSigner = await signerFromPrivateKeyString(alice.secretBase58);
  const keys = await deriveCtKeys(aliceSigner, mint); // same signatures -> same keys as step 02

  // --- 1. Mint PUBLIC tokens to Alice (plain Token-2022, fully visible) ----
  console.log(`Minting ${ui(MINT_AMOUNT)} public tokens to Alice:`);
  await executeInstructions(tools, [
    getMintToInstruction({ mint, token: address(alice.tokenAccount), mintAuthority: payer, amount: MINT_AMOUNT }),
  ]);
  await printBalances(alice.tokenAccount, keys, 'after mint');

  // --- 2. Deposit: public -> encrypted PENDING ------------------------------
  // The amount here is a PUBLIC instruction argument — anyone can see 500
  // entered the confidential system. Privacy begins once it's inside.
  console.log(`\nDepositing ${ui(DEPOSIT_AMOUNT)} into Alice's confidential PENDING balance:`);
  await executeInstructions(tools, [
    getConfidentialDepositInstruction({
      token: address(alice.tokenAccount),
      mint,
      authority: aliceSigner,
      amount: DEPOSIT_AMOUNT,
      decimals: DECIMALS,
    }),
  ]);
  await printBalances(alice.tokenAccount, keys, 'after deposit');

  // --- 3. Apply: PENDING -> AVAILABLE ---------------------------------------
  // Only Alice can do this: she decrypts her pending credits locally and
  // re-encrypts her new available balance under her own AES key.
  console.log('\nApplying the pending balance (Alice folds credits into her spendable balance):');
  const token = await fetchToken(rpc, address(alice.tokenAccount), { commitment: 'confirmed' });
  await executeInstructions(tools, [
    getApplyConfidentialPendingBalanceInstructionFromToken({
      token: address(alice.tokenAccount),
      tokenAccount: token.data,
      authority: aliceSigner,
      elgamalSecretKey: keys.elgamalSecretKey,
      aesKey: keys.aesKey,
    }),
  ]);
  await printBalances(alice.tokenAccount, keys, 'after apply');

  console.log(`\nDone. Alice now has ${ui(DEPOSIT_AMOUNT)} SPENDABLE confidential tokens,`);
  console.log('and the remainder is still public. Step 04 sends some of it to Bob — secretly.');
}

main().catch(err => {
  console.error('\nSTEP 03 FAILED:', err);
  process.exit(1);
});
