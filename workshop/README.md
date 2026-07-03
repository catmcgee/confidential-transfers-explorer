# Confidential Transfers Workshop — Steps

A five-step walkthrough of Solana Token-2022 Confidential Transfers on devnet. Each step matches an action in the [deployed explorer app](https://confidential-transfers-explorer-web.vercel.app): a diagram-first guide of what happens under the hood, paired with a minimal standalone script that does exactly what the app does — runnable against devnet, narrating itself via `console.log`.

The production implementation of the same flows is in the app source: [`apps/web/src/lib/confidentialTransfer.ts`](https://github.com/catmcgee/confidential-transfers-explorer/blob/main/apps/web/src/lib/confidentialTransfer.ts) and [`apps/web/src/components/TransferModal.tsx`](https://github.com/catmcgee/confidential-transfers-explorer/blob/main/apps/web/src/components/TransferModal.tsx).

## Prerequisites

- Node 22+ (scripts run under **Node, not bun** — the ZK SDK ships WASM ESM modules)
- Deps installed at the repo root
- A funded devnet payer in `FAUCET_PRIVATE_KEY` in `apps/web/.env` (falls back to airdrop)

Every step runs the same way:

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/<step>.ts
```

## The steps

| # | In the app | Script | Guide | What it teaches |
|---|---|---|---|---|
| 00 | Every import in the app + scripts | — | [`00-libraries.md`](00-libraries.md) | The stack: kit, token-2022 + its `/confidential` helpers, the WASM zk-sdk, ConnectorKit; the Node/WASM runtime note |
| 01 | The mint behind the faucet | [`01-create-mint.ts`](01-create-mint.ts) | [`01-create-mint.md`](01-create-mint.md) | The mint opts in via one extension; the auditor field is the compliance hook; confidential mint & burn |
| 02 | **Configure Confidential** + two signature prompts | [`02-configure-account.ts`](02-configure-account.ts) | [`02-configure-account.md`](02-configure-account.md) | Keys derived from signatures over readable text; ElGamal pubkey published on-chain; why recipients configure first |
| 03 | **Deposit** and **Apply Pending** | [`03-deposit-and-apply.ts`](03-deposit-and-apply.ts) | [`03-deposit-and-apply.md`](03-deposit-and-apply.md) | The three balances (public/pending/available) and why pending exists |
| 04 | **Send** with the multi-transaction progress bar | [`04-confidential-transfer.ts`](04-confidential-transfer.ts) | [`04-confidential-transfer.md`](04-confidential-transfer.md) | The 3 ZK proofs, the 1232-byte limit, context-state scratch accounts, ~5 transactions |
| 05 | **Click to decrypt** balances | [`05-decrypt.ts`](05-decrypt.ts) | [`05-decrypt.md`](05-decrypt.md) | ElGamal vs AES decryption paths; what an outsider sees (ciphertext); the public boundary |

Steps share progress through `state.json` (gitignored) in this directory — mint address, Alice/Bob secrets, token accounts. Run them in order; each step tells you which predecessor to run if state is missing. Delete `state.json` to start a fresh run with a new mint.

`helpers.ts` is the deliberately-boring plumbing (RPC, payer, transaction executor with per-instruction narration, key derivation, decrypt utilities). Skim once, then ignore.

Slide images used by the guides are in [`assets/`](assets/).
