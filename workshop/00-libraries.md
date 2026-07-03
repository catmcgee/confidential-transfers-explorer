# Step 00 — Token-2022 and the Libraries

Confidential Transfers is not a separate protocol — it's a **token extension** of [Token-2022](https://github.com/solana-program/token-2022), Solana's extended token program. Token-2022 works like the original SPL token program but lets mints and accounts opt into extra behaviors (transfer fees, interest, metadata, ...). Confidential Transfers is one of those extensions: the **mint** opts in when it's created (step 01), and each **token account** opts in by configuring itself with an encryption key (step 04 — you'll first watch a transfer to an *unconfigured* account fail in step 03). Everything else — deposits, encrypted transfers, decryption — builds on that.

Two on-chain programs are involved: **Token-2022** (holds the balances, executes the instructions) and the **ZK ElGamal Proof program** (verifies the zero-knowledge proofs transfers rely on).

## The libraries

| Package | Version | Role |
|---|---|---|
| [`@solana/kit`](https://github.com/anza-xyz/kit) | 6.x | RPC, transactions, signers, instruction plans. Successor to web3.js. |
| [`@solana-program/token-2022`](https://github.com/solana-program/token-2022) | 0.12+ | Builders for every Token-2022 instruction — plus the **`/confidential` subpath** with the high-level helpers this workshop leans on. |
| [`@solana/zk-sdk`](https://www.npmjs.com/package/@solana/zk-sdk) | 0.4+ | The cryptography: ElGamal/AES keys, ciphertexts, ZK proof generation. The CLI's Rust code compiled to WASM — JavaScript never reimplements crypto. |
| [`@solana/connector`](https://github.com/solana-foundation/connectorkit) | 0.2+ | ConnectorKit — wallet connection in the app (browser only). |

The import that matters most:

```ts
import {
  getCreateConfidentialTransferAccountInstructionPlan,
  getConfidentialTransferInstructionPlan,
  getApplyConfidentialPendingBalanceInstructionFromToken,
} from '@solana-program/token-2022/confidential';
```

These return kit **instruction plans**: the transfer helper alone generates three ZK proofs, verifies them via temporary context accounts, executes the transfer, and cleans up — you just execute the plan.

## Runtime note: WASM

`@solana/zk-sdk` ships WebAssembly as ES modules. Scripts run under **Node 22+** (not bun): `NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/01-create-mint.ts`. In the browser, the bundler handles it — proofs generate client-side, secrets never leave the page.

## FAQ

**Why kit 6.x and not 7?**
`@solana-program/token-2022` 0.12 peer-depends on kit `^6.4`. Pin 6.x until the range moves.

**Can I use web3.js v1 instead?**
Not for the confidential helpers — they're kit-native.

**Is the crypto in JavaScript?**
No — same Rust as the Solana CLI (`solana-zk-sdk`), compiled to WASM.

---

Next: [Step 01 — the mint](01-create-mint.md)
