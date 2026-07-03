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
| 00 | — | — | [`00-libraries.md`](00-libraries.md) | Confidential Transfers is a Token-2022 extension; the libraries (kit, token-2022 `/confidential`, WASM zk-sdk) |
| 01 | The mint behind the faucet | [`01-create-mint.ts`](01-create-mint.ts) | [`01-create-mint.md`](01-create-mint.md) | The mint opts in via one extension; the auditor field is the compliance hook; confidential mint & burn |
| 02 | **Deposit** and **Apply Pending** | [`02-deposit-and-apply.ts`](02-deposit-and-apply.ts) | [`02-deposit-and-apply.md`](02-deposit-and-apply.md) | The three balances (public/pending/available) and why pending exists |
| 03 | **Configure Confidential** + two signature prompts | [`03-configure-account.ts`](03-configure-account.ts) | [`03-configure-account.md`](03-configure-account.md) | Keys derived from signatures over readable text; ElGamal pubkey published on-chain — proven by re-deriving and matching the on-chain pubkey; without it a transfer has nothing to encrypt to (step 04 shows that failure live) |
| 04 | **Send** — first to an unconfigured recipient (the app's "recipient has not configured" error, a callback to step 03), then for real with the multi-transaction progress bar | [`04-confidential-transfer.ts`](04-confidential-transfer.ts) | [`04-confidential-transfer.md`](04-confidential-transfer.md) | Why sending to an unconfigured account fails; the 3 ZK proofs, the 1232-byte limit, context-state scratch accounts, ~5 transactions |
| 05 | **Click to decrypt** balances | [`05-decrypt.ts`](05-decrypt.ts) | [`05-decrypt.md`](05-decrypt.md) | ElGamal vs AES decryption paths; what an outsider sees (ciphertext); the public boundary |

Steps share progress through `state.json` (gitignored) in this directory — mint address, Alice/Bob secrets, token accounts. Run them in order; each step tells you which predecessor to run if state is missing. Delete `state.json` to start a fresh run with a new mint.

`helpers.ts` is the deliberately-boring plumbing (RPC, payer, transaction executor with per-instruction narration, key derivation, decrypt utilities). Skim once, then ignore.

Slide images used by the guides are in [`assets/`](assets/).
