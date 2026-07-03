# Step 03 — The Confidential Transfer

![Sender → ZK proof program + Token-2022 → recipient](assets/architecture-overview.png)

## Finding the recipient's key (and why unconfigured recipients fail)

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018','actorBkg':'#16161f','actorTextColor':'#ffffff','actorBorder':'#9945FF','signalColor':'#e6e6f0','signalTextColor':'#e6e6f0','noteBkgColor':'#241b38','noteTextColor':'#e6e6f0','noteBorderColor':'#9945FF','labelBoxBkgColor':'#16161f','labelTextColor':'#ffffff','loopTextColor':'#e6e6f0'}}}%%
flowchart LR
    ADDR["Bob's wallet address"] --> ATA["derive ATA<br/>(owner, mint, Token-2022)"]
    ATA --> FETCH["fetch token account"]
    FETCH --> EXT["read ConfidentialTransferAccount<br/>extension"]
    EXT --> PK["elgamal_pubkey field"]
    PK --> ENC["encrypt transfer amount<br/>to this key"]
    FAIL["no extension →<br/>'Token account is missing the<br/>ConfidentialTransferAccount extension'<br/>= the app's 'recipient has not configured'"]
    FETCH -.-> FAIL
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    class PK accent
```

## The amount is encrypted three ways

![One amount, encrypted to sender, receiver, and auditor keys](assets/three-key-encryption.png)

## The three proofs

![Range, equality, and validity proofs on every transfer](assets/per-transfer-proofs.png)

| Proof | Claim it certifies | Attack it prevents |
|---|---|---|
| **Equality** | Alice's new encrypted balance = old balance − amount | conjuring tokens by lying about your new balance |
| **Ciphertext validity** | the grouped ciphertexts encrypt the same amount for sender/receiver/auditor | sending Bob garbage he can't decrypt |
| **Range** (Bulletproof, u128) | amount and remaining balance are non-negative | "sending −5 tokens" to print 5 for yourself |

## Why five transactions

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018','actorBkg':'#16161f','actorTextColor':'#ffffff','actorBorder':'#9945FF','signalColor':'#e6e6f0','signalTextColor':'#e6e6f0','noteBkgColor':'#241b38','noteTextColor':'#e6e6f0','noteBorderColor':'#9945FF','labelBoxBkgColor':'#16161f','labelTextColor':'#ffffff','loopTextColor':'#e6e6f0'}}}%%
sequenceDiagram
    participant A as Alice's machine
    participant ZK as ZK ElGamal Proof program
    participant T22 as Token-2022
    Note over A: encrypt amount + generate 3 proofs locally
    A->>ZK: tx 1 - create ctx account + VerifyCiphertextCommitmentEquality
    A->>ZK: tx 2 - create ctx account + VerifyBatchedGroupedCiphertext3HandlesValidity
    A->>ZK: tx 3 - create ctx account (range proof too big to include verify)
    A->>ZK: tx 4 - VerifyBatchedRangeProofU128 (~1.5 KB proof)
    A->>T22: tx 5 - ConfidentialTransfer (references the 3 ctx accounts)
    A->>ZK: tx 5 (same tx) - CloseContextState x3 → rent refunded to payer
    Note over T22: homomorphically: source available -= amount,<br/>dest pending += amount
```

## The helpers

- **`getConfidentialTransferInstructionPlan`** (`@solana-program/token-2022/confidential`) — the whole flow: three proofs, context-state lifecycle, transfer. The fetched accounts you pass in are the snapshot the proofs bind to.

  ```ts
  await getConfidentialTransferInstructionPlan({ sourceToken, destinationToken, mint, authority, amount,
    sourceTokenAccount, destinationTokenAccount, sourceElgamalKeypair, aesKey, payer, rpc })
  ```

- **`createTransactionPlanner`** + **`createTransactionPlanExecutor`** (`@solana/kit`) — pack the plan into ~5 transactions, sign and send each

- **`getConfidentialWithdrawInstructionPlan`** (`@solana-program/token-2022/confidential`) — the withdraw sibling: encrypted available → public, same proof machinery
