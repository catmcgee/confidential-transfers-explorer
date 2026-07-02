/**
 * STEP 01 — Create a Token-2022 mint that opts in to Confidential Transfers.
 *
 * WHAT THIS TEACHES
 *   Confidential transfers are not a separate program — they are an EXTENSION
 *   on a normal Token-2022 mint. The mint itself opts in at creation time by
 *   carrying a ConfidentialTransferMint extension. Everything else (public
 *   balances, mint authority, decimals) works exactly like any other token.
 *
 *   The extension has three fields worth pointing at on screen:
 *     - authority:             who may update the extension's config later
 *     - autoApproveNewAccounts: we use TRUE, so anyone can configure a
 *                               confidential account without permission.
 *                               Set FALSE for allowlist-style compliance.
 *     - auditorElgamalPubkey:  we use NULL (no auditor). If set, every
 *                               transfer amount is ALSO encrypted to this
 *                               key, so a designated auditor can decrypt
 *                               amounts — compliance without a public ledger.
 *
 * WHAT TO POINT AT
 *   Open the mint address on the explorer and show the extension list on the
 *   account: "ConfidentialTransferMint" sits right next to ordinary mint data.
 *
 * RUN
 *   NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/01-create-mint.ts
 */
import { generateKeyPairSigner, nonDivisibleSequentialInstructionPlan } from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMintInstruction,
  getMintSize,
} from '@solana-program/token-2022';
import { getCreateAccountInstruction } from '@solana-program/system';

import { DECIMALS, createTools, executePlan, explorerAddress, loadPayer, rpc, writeState } from './helpers.ts';

async function main() {
  console.log('STEP 01 — create a confidential-transfer-enabled mint (devnet)\n');

  const payer = await loadPayer();
  const tools = createTools(payer);

  // A mint is just an account owned by the Token-2022 program. We generate a
  // fresh keypair for it and size the account to hold the extension data.
  const mintSigner = await generateKeyPairSigner();
  const mint = mintSigner.address;

  const ctMintExtension = extension('ConfidentialTransferMint', {
    authority: payer.address,          // can update the CT config later
    autoApproveNewAccounts: true,      // no gatekeeping: anyone can opt in
    auditorElgamalPubkey: null,        // no auditor — amounts visible to NO third party
  });
  const space = BigInt(getMintSize([ctMintExtension]));
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();

  console.log(`New mint: ${mint}`);
  console.log(`  ${explorerAddress(mint)}`);
  console.log('\nSending one transaction with three instructions');
  console.log('(the extension MUST be initialized before the mint itself):');

  await executePlan(
    tools,
    nonDivisibleSequentialInstructionPlan([
      // 1. Allocate the account with room for the extension.
      getCreateAccountInstruction({
        payer,
        newAccount: mintSigner,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      // 2. Write the ConfidentialTransferMint extension (the opt-in).
      getInitializeConfidentialTransferMintInstruction({
        mint,
        authority: payer.address,
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: null,
      }),
      // 3. Initialize the ordinary mint data (decimals, mint authority).
      getInitializeMintInstruction({
        mint,
        decimals: DECIMALS,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
    ]),
  );

  console.log('\nDone. This mint now supports confidential transfers.');
  console.log('Open it in the explorer and point at the ConfidentialTransferMint extension:');
  console.log(`  ${explorerAddress(mint)}`);
  console.log('\nNote: the auditor field is empty. With an auditor key set, every transfer');
  console.log('amount would also be decryptable by that one designated party — that is the');
  console.log('compliance story: confidential to the world, visible to your auditor.');

  writeState({ mint, mintAuthority: payer.address, decimals: DECIMALS });
}

main().catch(err => {
  console.error('\nSTEP 01 FAILED:', err);
  process.exit(1);
});
