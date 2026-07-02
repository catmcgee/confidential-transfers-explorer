# Confidential Transfers Workshop — Script Module

A five-step, run-it-live walkthrough of Solana Token-2022 Confidential Transfers on devnet. Each numbered script is standalone-runnable, narrates itself via `console.log`, and has a matching markdown guide with slides, diagrams, and protocol internals — the guides are what you put on screen; the scripts are what you run.

The presenter's guide (flow, timings, checklist, troubleshooting) lives at the repo root: [`WORKSHOP.md`](../../../../WORKSHOP.md).

## Prerequisites

- Node 22+ (scripts run under **Node, not bun** — the ZK SDK ships WASM ESM modules)
- Deps installed at the repo root
- A funded devnet payer in `FAUCET_PRIVATE_KEY` in `apps/web/.env` (falls back to airdrop)

Every step runs the same way:

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/<step>.ts
```

## The steps

| # | Script | Guide | What it teaches |
|---|---|---|---|
| 01 | [`01-create-mint.ts`](01-create-mint.ts) | [`01-create-mint.md`](01-create-mint.md) | The mint opts in via one extension; the auditor field is the compliance hook |
| 02 | [`02-configure-account.ts`](02-configure-account.ts) | [`02-configure-account.md`](02-configure-account.md) | Keys derived from signatures over readable text; ElGamal pubkey published on-chain; why recipients configure first |
| 03 | [`03-deposit-and-apply.ts`](03-deposit-and-apply.ts) | [`03-deposit-and-apply.md`](03-deposit-and-apply.md) | The three balances (public/pending/available) and why pending exists |
| 04 | [`04-confidential-transfer.ts`](04-confidential-transfer.ts) | [`04-confidential-transfer.md`](04-confidential-transfer.md) | The 3 ZK proofs, the 1232-byte limit, context-state scratch accounts, ~5 transactions |
| 05 | [`05-decrypt.ts`](05-decrypt.ts) | [`05-decrypt.md`](05-decrypt.md) | ElGamal vs AES decryption paths; what an outsider sees (ciphertext) |

Steps share progress through `state.json` (gitignored) in this directory — mint address, Alice/Bob secrets, token accounts. Run them in order; each step tells you which predecessor to run if state is missing. Delete `state.json` to start a fresh run with a new mint.

`helpers.ts` is the deliberately-boring plumbing (RPC, payer, transaction executor with per-instruction narration, key derivation, decrypt utilities). Skim once, then ignore.

Slide images used by the guides are in [`assets/`](assets/).
