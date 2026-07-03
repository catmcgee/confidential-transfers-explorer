# Step 05 — Decrypting (and What Everyone Else Sees)

![The recipient flow: funds arrive → apply pending → decrypt](assets/recipient-flow.png)

## Two decryption paths

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018','actorBkg':'#16161f','actorTextColor':'#ffffff','actorBorder':'#9945FF','signalColor':'#e6e6f0','signalTextColor':'#e6e6f0','noteBkgColor':'#241b38','noteTextColor':'#e6e6f0','noteBorderColor':'#9945FF','labelBoxBkgColor':'#16161f','labelTextColor':'#ffffff','loopTextColor':'#e6e6f0'}}}%%
flowchart TD
    subgraph ONCHAIN["On-chain account data (public bytes, unreadable)"]
        PLO["pending_balance_lo (ElGamal)"]
        PHI["pending_balance_hi (ElGamal)"]
        AV["available_balance (ElGamal)"]
        DAB["decryptable_available_balance (AES)"]
    end
    PLO -->|"ElGamal secret key<br/>discrete-log search: SLOW"| P["pending = lo + (hi << 16)<br/>= what Alice sent"]
    PHI -->|"ElGamal secret key"| P
    DAB -->|"AES key<br/>instant"| A["available = spendable total"]
    AV -.->|"never decrypted directly by the owner<br/>(the chain does homomorphic math on it;<br/>the AES cache mirrors its value)"| X[" "]
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    classDef ok fill:#0f2e21,stroke:#14F195,color:#ffffff
    class P accent
    class A ok
    style X fill:none,stroke:none
```

## The helpers

No high-level helper — the one step that talks to `@solana/zk-sdk` directly:

- **`ElGamalCiphertext.fromBytes`** + **`ElGamalSecretKey.decrypt`** (`@solana/zk-sdk`) — pending, via bounded discrete-log search

  ```ts
  const lo = elgamalSecretKey.decrypt(ElGamalCiphertext.fromBytes(ct.pendingBalanceLow));
  const hi = elgamalSecretKey.decrypt(ElGamalCiphertext.fromBytes(ct.pendingBalanceHigh));
  const pending = lo + (hi << 16n);
  ```

- **`AeCiphertext.fromBytes`** + **`AeKey.decrypt`** (`@solana/zk-sdk`) — available, instant

  ```ts
  const available = aesKey.decrypt(AeCiphertext.fromBytes(ct.decryptableAvailableBalance));
  ```

## The public boundary

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018'}}}%%
flowchart LR
    subgraph PUBLIC["Public world — amounts visible to everyone"]
        PB["Public token balance"]
    end
    subgraph CONF["Confidential world — amounts encrypted"]
        PEND["Pending"] --> AVAIL["Available"]
        AVAIL -->|"confidential transfer<br/>(amount hidden)"| PEND2["Recipient's pending"]
    end
    PB -->|"Deposit — amount is PUBLIC"| PEND
    AVAIL -->|"Withdraw — amount is PUBLIC"| PB
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    classDef ok fill:#0f2e21,stroke:#14F195,color:#ffffff
    class PEND,AVAIL,PEND2 accent
    class PB ok
```
