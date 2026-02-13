# Confidential Transfers (Token-2022 Extension)

## When to use this guidance

Use this guidance when the user asks about:

- Private/encrypted token balances on Solana
- Confidential transfers or balances
- Zero-knowledge proofs for token transfers
- Token-2022 confidential transfer extension(s)
- ElGamal encryption for tokens
- Building frontends/apps that interact with confidential transfers

## Current Network Availability

**Important:** Confidential transfers are currently only available on a custom cluster.

- RPC endpoint: `https://zk-edge.surfnet.dev:8899`
- WebSocket: `wss://zk-edge.surfnet.dev:8900`
- Mainnet availability expected in a few months

When building for confidential transfers, always use the ZK-Edge RPC for testing. Abstract the RPC endpoint into environment configuration for future mainnet migration. Ensure the user is aware of this.

## Key Concepts

### What are Confidential Transfers?

Confidential transfers encrypt token balances and transfer amounts using zero-knowledge cryptography. On-chain observers cannot see actual amounts, but the system still verifies:

- Sender has sufficient balance
- Transfer amounts are non-negative
- No tokens are created or destroyed

### Balance Types

Each confidential-enabled token account has three balance types:

- **Public**: Standard visible SPL balance (readable by anyone)
- **Pending**: Encrypted incoming transfers awaiting application (ElGamal encrypted)
- **Available**: Encrypted balance ready for outgoing transfers (ElGamal encrypted + AE encrypted copy)

The flow between balances is always: **Public -> Pending -> Available -> (Transfer or Withdraw)**

### Encryption Keys

Two keys are derived deterministically from the account owner's keypair:

- **ElGamal keypair**: Used for transfer encryption (asymmetric). The public key is stored on-chain. The secret key decrypts incoming ciphertexts.
- **AES key (AeKey)**: Used for "decryptable balance" - a convenience ciphertext that only the owner can read (symmetric, faster than ElGamal discrete log).

Key derivation uses wallet signature over a domain-separated message:
- ElGamal: `sign("ElGamalSecretKey" || token_account_address)` -> SHA-512 -> reduce mod scalar order
- AeKey: `sign("AeKey" || token_account_address)` -> SHA3-512 -> SHA3-512 -> first 16 bytes

### Balance Encryption Details

**Pending balance** is stored as two ElGamal ciphertexts split at 16 bits:
- `pending_balance_lo`: Encrypts `amount & 0xFFFF` (lower 16 bits)
- `pending_balance_hi`: Encrypts `amount >> 16` (upper bits)
- **Reconstruction: `total = lo + (hi << 16)`**

> **CRITICAL BUG WARNING**: The split is at 16 bits, NOT 48 bits. Using `hi << 48` instead of `hi << 16` produces astronomically wrong values that may silently corrupt the `decryptable_available_balance` field when applying pending balance.

**Available balance** is stored as:
- `available_balance`: ElGamal ciphertext (64 bytes) - the canonical encrypted balance
- `decryptable_available_balance`: AE ciphertext (36 bytes) - client-maintained convenience field for fast decryption

**Transfer amounts** are also split at 16 bits for the grouped ciphertexts:
- `TRANSFER_AMOUNT_LO_BITS = 16`
- `amount_lo = amount & ((1 << 16) - 1)`
- `amount_hi = amount >> 16`

### ElGamal Decryption Limitations

ElGamal decryption uses Baby-step Giant-step (BSGS) discrete log, which is only practical for values up to approximately **2^32** (~4.29 billion).

For tokens with 9 decimals, this means:
- Maximum reliably decryptable raw value: ~4.29 billion
- Maximum reliably decryptable token amount: ~4.29 tokens

This is why balances are split into lo/hi parts:
- `pending_balance_lo` max value: 65,535 (16 bits) - always decryptable
- `pending_balance_hi` max value: depends on total balance, but for reasonable amounts, stays within BSGS range
- For a 10-token balance with 9 decimals (raw: 10,000,000,000): lo = 58,368, hi = 152,587 - both well within BSGS range

The `decryptable_available_balance` (AE ciphertext) does NOT have this limitation - AE decryption is direct, not discrete-log-based. Always prefer AE decryption for the available balance.

### Privacy Levels

Mints can configure four privacy modes via `ConfidentialTransferMint`:

- `Disabled`: No confidential transfers
- `Whitelisted`: Only approved accounts (requires `auto_approve_new_accounts = false`)
- `OptIn`: Accounts choose to enable (requires `auto_approve_new_accounts = true`)
- `Required`: All transfers must be confidential

### Program IDs

- Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
- ZK ElGamal Proof Program: `ZkE1Gama1Proof11111111111111111111111111111`

## Operation Flow

The complete flow for confidential transfers:

1. **Configure** - Enable confidential transfers on a token account (reallocate + configure with ElGamal pubkey validity proof)
2. **Deposit** - Move tokens from public to pending balance
3. **Apply Pending** - Move pending to available balance (requires decrypting pending balance to compute new available)
4. **Transfer** - Send from available balance using ZK proofs (5-7 transactions for split proofs)
5. **Withdraw** - Move from available back to public balance (requires ZK proofs)

**Important**: Steps must be performed in order. The most common user confusion is:
- Depositing and expecting to immediately transfer (must apply pending first)
- Not understanding why "apply pending" is needed (pending is a staging area for incoming funds)
- Clicking "decrypt" and seeing nothing happen (see balance reconstruction bugs below)

## Rust Dependencies

```toml
[dependencies]
# Solana core
solana-sdk = "3.0.0"
solana-client = "3.1.6"
solana-zk-sdk = "5.0.0"
solana-commitment-config = "3.1.0"

# Token-2022
spl-token-2022 = { version = "10.0.0", features = ["zk-ops"] }
spl-token-client = "0.18.0"
spl-associated-token-account = "8.0.0"

# Confidential transfer proofs
spl-token-confidential-transfer-proof-generation = "0.5.1"
spl-token-confidential-transfer-proof-extraction = "0.5.1"

# Async runtime
tokio = { version = "1", features = ["full"] }
```

## TypeScript/JavaScript Dependencies

```json
{
  "dependencies": {
    "@solana/zk-sdk": "^0.3.1",
    "@solana-program/token-2022": "^0.9.0",
    "@solana/kit": "^5.5.1",
    "@solana/spl-token": "^0.4.14",
    "@solana/web3.js": "^1.98.4",
    "@noble/curves": "^2.0.1",
    "@noble/hashes": "^2.0.1",
    "bs58": "^6.0.0"
  }
}
```

**WebAssembly requirement**: The `@solana/zk-sdk` package requires WebAssembly. For Next.js, enable it in `next.config.ts`:

```typescript
const nextConfig = {
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};
```

## Common Types

```rust
use solana_sdk::signature::Signature;
use std::error::Error;

pub type CtResult<T> = Result<T, Box<dyn Error>>;
pub type SigResult = CtResult<Signature>;
pub type MultiSigResult = CtResult<Vec<Signature>>;
```

## Key Operations (Rust)

### 1. Configure Account for Confidential Transfers

Before using confidential transfers, accounts must be configured with encryption keys:

```rust
use solana_client::rpc_client::RpcClient;
use solana_sdk::{signature::Signer, transaction::Transaction};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_token_2022::{
    extension::{
        confidential_transfer::instruction::{configure_account, PubkeyValidityProofData},
        ExtensionType,
    },
    instruction::reallocate,
    solana_zk_sdk::encryption::{auth_encryption::AeKey, elgamal::ElGamalKeypair},
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;

pub async fn configure_account_for_confidential_transfers(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    // Derive encryption keys deterministically from authority
    let elgamal_keypair = ElGamalKeypair::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;
    let aes_key = AeKey::new_from_signer(
        authority,
        &token_account.to_bytes(),
    )?;

    let max_pending_balance_credit_counter = 65536u64;
    let decryptable_balance = aes_key.encrypt(0);

    // Generate proof that we control the ElGamal public key
    let proof_data = PubkeyValidityProofData::new(&elgamal_keypair)
        .map_err(|_| "Failed to generate pubkey validity proof")?;

    let proof_location = ProofLocation::InstructionOffset(
        1.try_into().unwrap(),
        &proof_data,
    );

    let mut instructions = vec![];

    // 1. Reallocate to add ConfidentialTransferAccount extension
    instructions.push(reallocate(
        &spl_token_2022::id(),
        &token_account,
        &payer.pubkey(),
        &authority.pubkey(),
        &[&authority.pubkey()],
        &[ExtensionType::ConfidentialTransferAccount],
    )?);

    // 2. Configure account (includes proof instruction)
    instructions.extend(configure_account(
        &spl_token_2022::id(),
        &token_account,
        mint,
        &decryptable_balance.into(),
        max_pending_balance_credit_counter,
        &authority.pubkey(),
        &[],
        proof_location,
    )?);

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &[authority, payer],
        recent_blockhash,
    );

    let signature = client.send_and_confirm_transaction(&transaction)?;
    Ok(signature)
}
```

### 2. Deposit to Confidential Balance

```rust
use spl_token_2022::extension::confidential_transfer::instruction::deposit;

pub async fn deposit_to_confidential(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
    amount: u64,
    decimals: u8,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    let deposit_ix = deposit(
        &spl_token_2022::id(),
        &token_account,
        mint,
        amount,
        decimals,
        &authority.pubkey(),
        &[&authority.pubkey()],
    )?;

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[deposit_ix],
        Some(&payer.pubkey()),
        &[payer, authority],
        recent_blockhash,
    );

    Ok(client.send_and_confirm_transaction(&transaction)?)
}
```

### 3. Apply Pending Balance

```rust
use spl_token_2022::extension::confidential_transfer::{
    instruction::apply_pending_balance as apply_pending_balance_instruction,
    ConfidentialTransferAccount,
};

pub async fn apply_pending_balance(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(),
        mint,
        &spl_token_2022::id(),
    );

    let elgamal_keypair = ElGamalKeypair::new_from_signer(authority, &token_account.to_bytes())?;
    let aes_key = AeKey::new_from_signer(authority, &token_account.to_bytes())?;

    let account_data = client.get_account(&token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;

    // Decrypt pending balance (ElGamal BSGS)
    let pending_lo_ct: ElGamalCiphertext = ct_extension.pending_balance_lo.try_into()?;
    let pending_hi_ct: ElGamalCiphertext = ct_extension.pending_balance_hi.try_into()?;

    let pending_lo = pending_lo_ct.decrypt_u32(elgamal_keypair.secret()).unwrap_or(0) as u64;
    let pending_hi = pending_hi_ct.decrypt_u32(elgamal_keypair.secret()).unwrap_or(0) as u64;

    // CRITICAL: Shift by 16, NOT 48. The split is at 16 bits.
    let pending_total = pending_lo + (pending_hi << 16);

    // Decrypt current available balance (use AE key for reliability)
    let current_available = aes_key.decrypt(
        &ct_extension.decryptable_available_balance.try_into()?
    )?;

    let new_available = current_available + pending_total;
    let new_decryptable_balance = aes_key.encrypt(new_available);

    let expected_counter: u64 = ct_extension.pending_balance_credit_counter.into();

    let apply_ix = apply_pending_balance_instruction(
        &spl_token_2022::id(),
        &token_account,
        expected_counter,
        &new_decryptable_balance.into(),
        &authority.pubkey(),
        &[&authority.pubkey()],
    )?;

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &[apply_ix],
        Some(&payer.pubkey()),
        &[payer, authority],
        recent_blockhash,
    );

    Ok(client.send_and_confirm_transaction(&transaction)?)
}
```

### 4. Confidential Transfer (Split Proofs)

Transfers require multiple transactions because ZK proofs exceed single transaction size limits:

```rust
use spl_token_2022::extension::confidential_transfer::account_info::TransferAccountInfo;
use spl_token_client::token::{ProofAccountWithCiphertext, Token};

pub async fn transfer_confidential(
    client: &RpcClient,
    sender: &Keypair,
    mint: &solana_sdk::pubkey::Pubkey,
    recipient: &solana_sdk::pubkey::Pubkey,
    amount: u64,
) -> MultiSigResult {
    let sender_token_account = get_associated_token_address_with_program_id(
        &sender.pubkey(), mint, &spl_token_2022::id(),
    );
    let recipient_token_account = get_associated_token_address_with_program_id(
        recipient, mint, &spl_token_2022::id(),
    );

    // Get recipient's ElGamal public key from their token account
    let recipient_account_data = client.get_account(&recipient_token_account)?;
    let recipient_account = StateWithExtensions::<TokenAccount>::unpack(&recipient_account_data.data)?;
    let recipient_ct = recipient_account.get_extension::<ConfidentialTransferAccount>()?;
    let recipient_elgamal_pubkey: ElGamalPubkey = recipient_ct.elgamal_pubkey.try_into()?;

    // Get auditor ElGamal public key from mint (may be None)
    let mint_data = client.get_account(mint)?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data.data)?;
    let mint_ct = mint_state.get_extension::<ConfidentialTransferMint>()?;
    let auditor_pubkey: Option<ElGamalPubkey> =
        Option::<PodElGamalPubkey>::from(mint_ct.auditor_elgamal_pubkey)
            .map(|pk| pk.try_into()).transpose()?;

    // Derive sender's keys
    let sender_elgamal = ElGamalKeypair::new_from_signer(sender, &sender_token_account.to_bytes())?;
    let sender_aes = AeKey::new_from_signer(sender, &sender_token_account.to_bytes())?;

    // Get transfer account info and generate split proofs
    let account_data = client.get_account(&sender_token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;
    let transfer_info = TransferAccountInfo::new(ct_extension);

    let proof_data = transfer_info.generate_split_transfer_proof_data(
        amount, &sender_elgamal, &sender_aes,
        &recipient_elgamal_pubkey, auditor_pubkey.as_ref(),
    )?;

    // Create Token client for proof account management
    let token = Token::new(/* ... */);

    let equality_proof_account = Keypair::new();
    let validity_proof_account = Keypair::new();
    let range_proof_account = Keypair::new();

    let mut signatures = Vec::new();

    // TX 1: Create & verify equality proof context
    signatures.push(token.confidential_transfer_create_context_state_account(
        &equality_proof_account.pubkey(), &sender.pubkey(),
        &proof_data.equality_proof_data, false,
        &[&equality_proof_account],
    ).await?);

    // TX 2: Create & verify ciphertext validity proof context
    signatures.push(token.confidential_transfer_create_context_state_account(
        &validity_proof_account.pubkey(), &sender.pubkey(),
        &proof_data.ciphertext_validity_proof_data_with_ciphertext.proof_data, false,
        &[&validity_proof_account],
    ).await?);

    // TX 3: Create & verify range proof context
    signatures.push(token.confidential_transfer_create_context_state_account(
        &range_proof_account.pubkey(), &sender.pubkey(),
        &proof_data.range_proof_data, true,
        &[&range_proof_account],
    ).await?);

    // TX 4: Execute the confidential transfer
    let validity_proof = ProofAccountWithCiphertext {
        context_state_account: validity_proof_account.pubkey(),
        ciphertext_lo: proof_data.ciphertext_validity_proof_data_with_ciphertext.ciphertext_lo,
        ciphertext_hi: proof_data.ciphertext_validity_proof_data_with_ciphertext.ciphertext_hi,
    };

    signatures.push(token.confidential_transfer_transfer(
        &sender_token_account, &recipient_token_account, &sender.pubkey(),
        Some(&equality_proof_account.pubkey()),
        Some(&validity_proof),
        Some(&range_proof_account.pubkey()),
        amount, None, &sender_elgamal, &sender_aes,
        &recipient_elgamal_pubkey, auditor_pubkey.as_ref(),
        &[sender],
    ).await?);

    // TX 5-7: Close proof context accounts to reclaim rent
    for account in [&equality_proof_account, &validity_proof_account, &range_proof_account] {
        signatures.push(token.confidential_transfer_close_context_state_account(
            &account.pubkey(), &sender_token_account, &sender.pubkey(), &[sender],
        ).await?);
    }

    Ok(signatures)
}
```

### 5. Withdraw from Confidential Balance

```rust
use spl_token_2022::extension::confidential_transfer::account_info::WithdrawAccountInfo;

pub async fn withdraw_from_confidential(
    client: &RpcClient,
    payer: &dyn Signer,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
    amount: u64,
    decimals: u8,
) -> SigResult {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(), mint, &spl_token_2022::id(),
    );

    let elgamal_keypair = ElGamalKeypair::new_from_signer(authority, &token_account.to_bytes())?;
    let aes_key = AeKey::new_from_signer(authority, &token_account.to_bytes())?;

    let account_data = client.get_account(&token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;

    let withdraw_info = WithdrawAccountInfo::new(ct_extension);
    let proof_data = withdraw_info.generate_proof_data(amount, &elgamal_keypair, &aes_key)?;

    // Calculate new decryptable balance
    let available: ElGamalCiphertext = withdraw_info.available_balance.try_into()?;
    let current = available.decrypt_u32(elgamal_keypair.secret()).ok_or("decrypt failed")?;
    let new_decryptable = aes_key.encrypt(current - amount);

    let withdraw_ixs = withdraw(
        &spl_token_2022::id(), &token_account, mint,
        amount, decimals, &new_decryptable.into(),
        &authority.pubkey(), &[&authority.pubkey()],
        ProofLocation::InstructionOffset(1.try_into().unwrap(), &proof_data.equality_proof_data),
        ProofLocation::InstructionOffset(2.try_into().unwrap(), &proof_data.range_proof_data),
    )?;

    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &withdraw_ixs, Some(&payer.pubkey()), &[payer, authority], recent_blockhash,
    );

    Ok(client.send_and_confirm_transaction(&transaction)?)
}
```

## TypeScript/JavaScript Implementation

### Key Derivation

```typescript
import { sha3_512 } from '@noble/hashes/sha3.js';

// ElGamal key derivation
const elgamalMessage = concat("ElGamalSecretKey", tokenAccountAddressBytes);
const signature = await wallet.signMessage(elgamalMessage);
const secretKeyBytes = sha512ThenReduceModScalarOrder(signature);
const secretKey = ElGamalSecretKey.fromBytes(secretKeyBytes);
const keypair = ElGamalKeypair.fromSecretKey(secretKey);

// AeKey derivation (double SHA3-512 hash)
const aeMessage = concat("AeKey", tokenAccountAddressBytes);
const aeSignature = await wallet.signMessage(aeMessage);
const seed = sha3_512(aeSignature);        // Step 1: seed
const aeKeyBytes = sha3_512(seed).slice(0, 16); // Step 2: key
const aeKey = AeKey.fromBytes(aeKeyBytes);
```

### Decrypting Balances

```typescript
// Pending balance (ElGamal) - from RPC jsonParsed response
const pendingLoBytes = base64Decode(ctState.pendingBalanceLo); // 64-byte ElGamal ciphertext
const pendingHiBytes = base64Decode(ctState.pendingBalanceHi);

const pendingLo = secretKey.decrypt(ElGamalCiphertext.fromBytes(pendingLoBytes));
const pendingHi = secretKey.decrypt(ElGamalCiphertext.fromBytes(pendingHiBytes));

// CRITICAL: Shift by 16, NOT 48
const pendingBalance = pendingLo + (pendingHi << 16n);

// Available balance (AE) - fast, reliable, no BSGS limitation
const aeBytes = base64Decode(ctState.decryptableAvailableBalance); // 36-byte AE ciphertext
const availableBalance = AeCiphertext.fromBytes(aeBytes).decrypt(aeKey);
```

### Transfer Proofs in TypeScript

The `@solana/zk-sdk` WASM module provides all the proof generation classes:

```typescript
import { /* classes */ } from '@solana/zk-sdk/bundler';

// Split amount at 16 bits
const amountLo = amount & ((1n << 16n) - 1n);
const amountHi = amount >> 16n;

// Create grouped ciphertexts (always 3-handle: sender, recipient, auditor)
const groupedCiphertextLo = GroupedElGamalCiphertext3Handles.encryptWith(
  senderPubkey, recipientPubkey, auditorPubkey, amountLo, openingLo
);

// Generate proofs
const equalityProof = new CiphertextCommitmentEqualityProofData(
  senderKeypair, newBalanceCiphertext, newBalanceCommitment, newBalanceOpening, newBalance
);
const validityProof = new BatchedGroupedCiphertext3HandlesValidityProofData(
  senderPubkey, recipientPubkey, auditorPubkey,
  groupedCiphertextLo, groupedCiphertextHi,
  amountLo, amountHi, openingLo, openingHi
);
const rangeProof = new BatchedRangeProofU128Data(
  [newBalanceCommitment, commitmentLo, commitmentHi, paddingCommitment],
  new BigUint64Array([newBalance, amountLo, amountHi, 0n]),
  new Uint8Array([64, 16, 32, 16]), // bit lengths sum to 128
  [newBalanceOpening, openingLo, openingHi, paddingOpening]
);
```

### Homomorphic Balance Derivation

The new balance ciphertext after a transfer must be derived homomorphically:

```typescript
import { ristretto255 } from '@noble/curves/ed25519.js';
const RPoint = ristretto255.Point;

// new_balance_ct = source_available - amount_lo_sender - amount_hi_sender * 2^16
const newCommitment = srcCommitment.subtract(loCommitment).subtract(hiCommitment.multiply(2n ** 16n));
const newHandle = srcHandle.subtract(loHandle).subtract(hiHandle.multiply(2n ** 16n));
```

### Transfer Instruction Data Layout

The on-chain `TransferInstructionData` is 169 bytes:

```
[0]       u8  discriminator = 27 (ConfidentialTransferExtension)
[1]       u8  sub = 7 (Transfer)
[2-37]    DecryptableBalance (36 bytes) = new decryptable available balance
[38-101]  PodElGamalCiphertext (64 bytes) = auditor ciphertext lo
[102-165] PodElGamalCiphertext (64 bytes) = auditor ciphertext hi
[166]     i8  equality_proof_instruction_offset (0 = context state account)
[167]     i8  ciphertext_validity_proof_instruction_offset
[168]     i8  range_proof_instruction_offset
```

When offsets are 0, proof data is read from context state accounts (not sysvar instructions).

Account order for the transfer instruction:
```
0: source token account (writable)
1: mint (readonly)
2: destination token account (writable)
3: equality proof context state (readonly)
4: validity proof context state (readonly)
5: range proof context state (readonly)
6: authority (readonly signer)
```

## Reading Balances

```rust
pub fn get_confidential_balances(
    client: &RpcClient,
    authority: &dyn Signer,
    mint: &solana_sdk::pubkey::Pubkey,
) -> Result<(u64, u64, u64), Box<dyn std::error::Error>> {
    let token_account = get_associated_token_address_with_program_id(
        &authority.pubkey(), mint, &spl_token_2022::id(),
    );

    let elgamal_keypair = ElGamalKeypair::new_from_signer(authority, &token_account.to_bytes())?;
    let aes_key = AeKey::new_from_signer(authority, &token_account.to_bytes())?;

    let account_data = client.get_account(&token_account)?;
    let account = StateWithExtensions::<TokenAccount>::unpack(&account_data.data)?;
    let ct_extension = account.get_extension::<ConfidentialTransferAccount>()?;

    // Public balance
    let public_balance = account.base.amount;

    // Pending balance (ElGamal BSGS decrypt)
    let pending_lo_ct: ElGamalCiphertext = ct_extension.pending_balance_lo.try_into()?;
    let pending_hi_ct: ElGamalCiphertext = ct_extension.pending_balance_hi.try_into()?;
    let pending_lo = pending_lo_ct.decrypt_u32(elgamal_keypair.secret()).unwrap_or(0) as u64;
    let pending_hi = pending_hi_ct.decrypt_u32(elgamal_keypair.secret()).unwrap_or(0) as u64;
    let pending_balance = pending_lo + (pending_hi << 16); // MUST be << 16, NOT << 48

    // Available balance (AE decrypt - preferred for reliability)
    let available_balance = aes_key.decrypt(
        &ct_extension.decryptable_available_balance.try_into()?
    )?;

    Ok((public_balance, pending_balance, available_balance))
}
```

## Common Pitfalls and Bugs

### 1. Wrong bit shift in pending balance reconstruction
**Bug**: Using `hi << 48` instead of `hi << 16`
**Impact**: Produces astronomically wrong values. When this wrong value is used in `apply_pending_balance`, it corrupts the `decryptable_available_balance` field, causing all future balance reads to return garbage.
**Fix**: Always use `pending_lo + (pending_hi << 16)`.

### 2. ElGamal BSGS discrete log failure for large values
**Bug**: BSGS can only solve discrete log for values up to ~2^32. For tokens with 9 decimals, even a 5-token balance exceeds this.
**Impact**: `decrypt_u32` returns `None` / `null` or an incorrect value.
**Mitigation**: Use AE-encrypted `decryptable_available_balance` for the available balance. For pending balance, the 16-bit split ensures individual ciphertexts stay within range.

### 3. Silent failures in multi-step flow
**Bug**: User deposits tokens but doesn't apply pending balance, then tries to transfer.
**Impact**: Transfer fails silently because available balance is 0.
**Fix**: Check if pending balance > 0 and prompt user to apply it before transferring.

### 4. `@noble/curves` API rename
**Bug**: `ed25519.utils.randomPrivateKey()` was renamed to `ed25519.utils.randomSecretKey()` in v2.x.
**Impact**: Runtime crash with no clear error message.

### 5. `@solana-program/token-2022` SDK bugs in transfer instruction
**Bug**: The TypeScript SDK's transfer instruction builder (a) includes Token-2022 program ID as an extra account and (b) omits auditor ciphertext fields from instruction data (produces 41 bytes instead of 169).
**Fix**: Build the transfer instruction data manually (see layout above).

### 6. Context state account ownership
**Bug**: Context state accounts for ZK proofs must be owned by the ZK ElGamal Proof Program.
**Impact**: If you create them with the wrong owner, proof verification fails with "invalid account data".
**Fix**: Use `SystemProgram.createAccount` with `owner = ZkE1Gama1Proof11111111111111111111111111111`.

### 7. Grouped ciphertext handle count
**Bug**: The on-chain transfer processor ALWAYS expects 3-handle grouped ciphertexts (sender, recipient, auditor), even when there is no auditor.
**Impact**: Using 2-handle validity proofs causes "InvalidInstructionData" error.
**Fix**: Always use 3-handle ciphertexts. When no auditor, use a zero/identity ElGamal public key (32 zero bytes).

### 8. Range proof bit lengths must sum to 128
**Bug**: The `BatchedRangeProofU128` requires bit lengths that sum to exactly 128.
**Entries**: [newBalance: 64 bits, amountLo: 16 bits, amountHi: 32 bits, padding: 16 bits] = 128.
**Impact**: Wrong bit lengths cause proof generation failure.

### 9. Auditor ciphertext extraction from grouped ciphertexts
**Layout**: `GroupedElGamalCiphertext3Handles` = `[commitment(32)][handle1/source(32)][handle2/recipient(32)][handle3/auditor(32)]` = 128 bytes.
**Auditor's individual ciphertext**: `[commitment(32)][handle3(32)]` = bytes [0..32] + bytes [96..128].

## Security Considerations

- **Key derivation is deterministic**: Same keypair always produces the same encryption keys for a given token account. Keypair compromise exposes all confidential balances.
- **Auditor keys**: Mints can configure an auditor ElGamal public key that can decrypt transfer amounts (but not balances).
- **`decryptable_available_balance` is client-controlled**: The on-chain program does NOT validate this field. A buggy client can write a wrong value, causing future balance reads to be incorrect. The canonical balance is always the ElGamal `available_balance` ciphertext.
- **Pending balance limits**: `max_pending_balance_credit_counter` limits incoming transfers before `apply_pending` must be called (default: 65536).
- **Proof verification**: All proofs are verified by the ZK ElGamal Proof Program on-chain.

## Reference Implementations

- **Rust**: https://github.com/gitteri/confidential-balances-exploration
- **TypeScript (full explorer app)**: https://github.com/catmcgee/confidential-transfers-explorer
- **Solana Token-2022 source**: https://github.com/solana-labs/solana-program-library/tree/master/token/program-2022

## Limitations

- Currently only works on ZK-Edge testnet (`https://zk-edge.surfnet.dev:8899`)
- Transfer operations require 5-7 transactions due to ZK proof sizes (will decrease when larger transactions are supported on mainnet)
- Proof generation is computationally intensive (client-side WASM for TypeScript, native for Rust)
- ElGamal BSGS decryption limited to values < 2^32 (mitigated by balance splitting and AE encryption)
- Sender must be a `Keypair` (not generic `Signer`) for the Rust token client transfer API
- Browser implementations require WebAssembly support
