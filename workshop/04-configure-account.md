# Step 04 — Owners, Signature-Derived Keys, and Account Configuration

## Key derivation: signatures over readable text

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018','actorBkg':'#16161f','actorTextColor':'#ffffff','actorBorder':'#9945FF','signalColor':'#e6e6f0','signalTextColor':'#e6e6f0','noteBkgColor':'#241b38','noteTextColor':'#e6e6f0','noteBorderColor':'#9945FF','labelBoxBkgColor':'#16161f','labelTextColor':'#ffffff','loopTextColor':'#e6e6f0'}}}%%
flowchart TD
    W["Wallet private key<br/>(never leaves the wallet)"] -->|"signMessage"| M1["Text: 'ElGamalSecretKey:&lt;owner&gt;:&lt;mint&gt;'"]
    W -->|"signMessage"| M2["Text: 'AeKey:&lt;owner&gt;:&lt;mint&gt;'"]
    M1 --> S1["64-byte Ed25519 signature<br/>(deterministic)"]
    M2 --> S2["64-byte Ed25519 signature<br/>(deterministic)"]
    S1 --> K1["ElGamalKeypair.fromSignature()<br/>→ encrypts on-chain balances"]
    S2 --> K2["AeKey.fromSignature()<br/>→ owner's fast balance cache"]
    K1 -.->|"public half goes on-chain<br/>in ConfigureAccount"| CHAIN[("Token account:<br/>elgamal_pubkey")]
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    classDef ok fill:#0f2e21,stroke:#14F195,color:#ffffff
    class K1 accent
    class K2 ok
```

## Configuration bundles a proof

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018'}}}%%
flowchart LR
    A["create ATA"] --> B["reallocate for<br/>the extension"]
    B --> C["ConfigureAccount<br/>(elgamal pubkey +<br/>encrypted zero balance)"]
    C --> D["verify pubkey-validity proof<br/>(you hold the secret key<br/>behind this pubkey)"]
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    class D accent
```

## The helpers

- **`getCreateConfidentialTransferAccountInstructionPlan`** (`@solana-program/token-2022/confidential`) — one plan: ATA + reallocate + configure + pubkey-validity proof

  ```ts
  await getCreateConfidentialTransferAccountInstructionPlan({ payer, owner, mint, rpc, elgamalKeypair, aesKey })
  ```

- **`deriveElGamalKeypairForOwnerMint`** / **`deriveAeKeyForOwnerMint`** (`@solana-program/token-2022/confidential`) — official derivation, but signs a **raw-byte** message that Phantom refuses; use with keypair signers (scripts, backends)

  ```ts
  await deriveElGamalKeypairForOwnerMint({ signer, owner, mint })
  ```

- **`ElGamalKeypair.fromSignature`** / **`AeKey.fromSignature`** (`@solana/zk-sdk`) — browser-wallet-friendly: sign human-readable text, seed the keys from the signature

  ```ts
  ElGamalKeypair.fromSignature(await signText(`ElGamalSecretKey:${owner}:${mint}`))
  AeKey.fromSignature(await signText(`AeKey:${owner}:${mint}`))
  ```
