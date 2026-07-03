# Step 02 — Deposit and Apply: the Three Balances

![Pending vs available, and ApplyPendingBalance between them](assets/pending-vs-available.png)

## Why pending exists

![The dust race: a mutated ciphertext invalidates the in-flight proof](assets/proof-ciphertext-race.png)

## The lo/hi ciphertext trick

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018','actorBkg':'#16161f','actorTextColor':'#ffffff','actorBorder':'#9945FF','signalColor':'#e6e6f0','signalTextColor':'#e6e6f0','noteBkgColor':'#241b38','noteTextColor':'#e6e6f0','noteBorderColor':'#9945FF','labelBoxBkgColor':'#16161f','labelTextColor':'#ffffff','loopTextColor':'#e6e6f0'}}}%%
flowchart TD
    A["Deposit amount (48-bit max)<br/>e.g. 500000000000"] --> SPLIT{"split at bit 16"}
    SPLIT -->|"low 16 bits"| LO["pending_balance_lo<br/>ElGamal ciphertext of low 16 bits"]
    SPLIT -->|"amount shifted right 16"| HI["pending_balance_hi<br/>ElGamal ciphertext of high 32 bits"]
    LO --> DEC["owner decrypts:<br/>total = lo + (hi << 16)"]
    HI --> DEC
    DEC --> APPLY["ApplyPendingBalance:<br/>available += pending (homomorphic add)<br/>owner re-encrypts decryptable balance (AES)<br/>pending reset to zero-ciphertext<br/>(all-or-nothing: no amount field, no proofs)"]
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    classDef ok fill:#0f2e21,stroke:#14F195,color:#ffffff
    class LO,HI accent
    class APPLY ok
```

## The helpers

- **`getConfidentialDepositInstruction`** (`@solana-program/token-2022`) — public → pending; no proofs, amount is public

  ```ts
  getConfidentialDepositInstruction({ token, mint, authority, amount, decimals })
  ```

- **`getApplyConfidentialPendingBalanceInstructionFromToken`** (`@solana-program/token-2022/confidential`) — pending → available, all of it, no proofs

  ```ts
  const token = await fetchToken(rpc, tokenAddress);
  getApplyConfidentialPendingBalanceInstructionFromToken({ token, tokenAccount: token.data, authority, elgamalSecretKey, aesKey })
  ```
