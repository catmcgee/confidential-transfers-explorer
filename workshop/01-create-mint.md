# Step 01 — Create a Confidential-Transfer Mint

![Public vs confidential: same token, two worlds](assets/two-balances.png)

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'transparent','primaryColor':'#16161f','primaryTextColor':'#ffffff','primaryBorderColor':'#9945FF','secondaryColor':'#0f2e21','secondaryTextColor':'#ffffff','secondaryBorderColor':'#14F195','tertiaryColor':'#241b38','tertiaryTextColor':'#ffffff','lineColor':'#8b8ba7','textColor':'#e6e6f0','fontSize':'14px','clusterBkg':'#101018','clusterBorder':'#3a3a4d','edgeLabelBackground':'#101018','actorBkg':'#16161f','actorTextColor':'#ffffff','actorBorder':'#9945FF','signalColor':'#e6e6f0','signalTextColor':'#e6e6f0','noteBkgColor':'#241b38','noteTextColor':'#e6e6f0','noteBorderColor':'#9945FF','labelBoxBkgColor':'#16161f','labelTextColor':'#ffffff','loopTextColor':'#e6e6f0'}}}%%
flowchart LR
    A["1 - System program:<br/>create account<br/>(sized for the extension)"] --> B["2 - Token-2022:<br/>InitializeConfidentialTransferMint<br/>(authority, auto-approve, auditor)"]
    B --> C["3 - Token-2022:<br/>InitializeMint<br/>(decimals, mint authority)"]
    classDef accent fill:#241b38,stroke:#9945FF,color:#ffffff
    class B accent
```

| Field | Our value | What it controls |
|---|---|---|
| `authority` | the payer | who can change this config later |
| `autoApproveNewAccounts` | `true` | anyone may configure a confidential account |
| `auditorElgamalPubkey` | `null` | if set, every transfer amount is also decryptable by this one key |

## The helpers

No one-shot helper — three builders, extension **before** `InitializeMint`:

- **`getCreateAccountInstruction`** (`@solana-program/system`) — sized with `getMintSize([extension('ConfidentialTransferMint', {...})])`

  ```ts
  getCreateAccountInstruction({ payer, newAccount, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS })
  ```

- **`getInitializeConfidentialTransferMintInstruction`** (`@solana-program/token-2022`)

  ```ts
  getInitializeConfidentialTransferMintInstruction({ mint, authority, autoApproveNewAccounts, auditorElgamalPubkey })
  ```

- **`getInitializeMintInstruction`** (`@solana-program/token-2022`)

  ```ts
  getInitializeMintInstruction({ mint, decimals, mintAuthority, freezeAuthority })
  ```

## Confidential mint & burn

| Action | `ConfidentialTransferMint` only | + `ConfidentialMintBurn` |
|---|---|---|
| Transfer | amount encrypted | amount encrypted |
| Mint / burn | public supply changes — leaks amounts | encrypted; supply stays confidential |

- **`getInitializeConfidentialMintBurnInstruction`** (`@solana-program/token-2022`) — [extension source](https://github.com/solana-program/token-2022/tree/main/program/src/extension/confidential_mint_burn)
