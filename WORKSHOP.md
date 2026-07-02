# Confidential Transfers Workshop — Presenter's Guide

A ~1 hour workshop for Solana developers: what Token-2022 Confidential Transfers are, how they work, and how to build with them — demonstrated live on devnet with five short scripts.

**Primary walkthrough material:** each script has a matching markdown guide in [`apps/web/scripts/workshop/`](apps/web/scripts/workshop/README.md) with slide images, mermaid diagrams of the mechanics, the key code excerpt, real protocol (Rust) internals with source links, and an FAQ of likely audience questions. Put the guide on screen, run the script in a terminal next to it.

## Links

- Deployed explorer app: https://confidential-transfers-explorer-web.vercel.app
- Solana Explorer (devnet): https://explorer.solana.com/?cluster=devnet — every script prints per-transaction links
- Scripts + per-step guides: [`apps/web/scripts/workshop/`](apps/web/scripts/workshop/README.md)
- Protocol source: [token-2022 confidential transfer extension](https://github.com/solana-program/token-2022/tree/main/program/src/extension/confidential_transfer) · [ZK ElGamal proof program](https://github.com/solana-program/zk-elgamal-proof)

## Suggested flow (60 min)

1. **Live demo on the deployed app (10 min).** Open https://confidential-transfers-explorer-web.vercel.app, connect a wallet, show a confidential balance rendering as "encrypted", sign the two derivation messages, watch it decrypt. Sell the punchline before explaining it: *same on-chain bytes, and only the key holder sees a number.*
2. **The 3-concept primer (10 min)** — below.
3. **Scripts 01–05 (35 min).** For each step: put the guide `.md` on screen, talk through the diagram, run the script, read the console narration aloud, click one explorer link. Steps 01–02 are quick; budget the most time for 04.
4. **Q&A (5 min).** Each guide ends with a "what to say if asked" section — skim them beforehand.

## The 3-concept primer

Cover these three ideas up front; every step then reinforces one of them.

**1. Three balances.** A confidential account holds a normal *public* balance, plus two encrypted ones: *pending* (where incoming credits land — anyone can add to it homomorphically) and *available* (what you can spend — only the owner can rewrite it, by "applying" pending). Pending exists because spending requires proofs over your balance ciphertext, so that ciphertext must not change under your feet while others credit you.

**2. Signature-derived keys.** There are no stored encryption keys. The wallet signs two deterministic, human-readable messages (`ElGamalSecretKey:<owner>:<mint>` and `AeKey:<owner>:<mint>`); the signatures seed an ElGamal keypair and an AES key. Same text → same keys, anywhere, forever. Readable text because wallets like Phantom refuse opaque binary signMessage payloads. Configuring an account publishes the ElGamal *public* key on-chain — that's what senders encrypt to.

**3. Why 5 transactions.** A transfer needs three ZK proofs (equality, ciphertext validity, range). A Solana transaction caps at 1232 bytes; the range proof alone is ~1.5 KB. So each proof is verified into a temporary *context-state* scratch account first, the transfer instruction references all three, and they're closed with rent refunded — all in about five transactions.

## Pre-workshop checklist

- [ ] `FAUCET_PRIVATE_KEY` set in `apps/web/.env` and funded with **≥ 0.5 devnet SOL** (https://faucet.solana.com). Everything runs off this one payer.
- [ ] `SOLANA_RPC_URL` set in `apps/web/.env` to a reliable devnet RPC (a dedicated provider beats the public endpoint; the scripts fall back to `https://api.devnet.solana.com`).
- [ ] **Node 22+** installed (`node --version`) — the scripts run under Node via `npx tsx`, *not* bun (the ZK SDK's WASM ESM modules don't load under bun).
- [ ] Dependencies already installed at the repo root.
- [ ] Dry-run all five steps the day before (total ≈ 3–4 min of chain time):

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/01-create-mint.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/02-configure-account.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/03-deposit-and-apply.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/04-confidential-transfer.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/05-decrypt.ts
```

- [ ] **Time-constrained?** Run 01 + 02 in advance and start the live session at 03 — `state.json` persists the mint and the Alice/Bob wallets, so 03–05 pick up seamlessly. (Delete `state.json` to reset to a fresh mint.)

## Per-step run sheet

Full talk tracks live in each step's guide; this is the condensed version.

### 01 — Create the mint · [guide](apps/web/scripts/workshop/01-create-mint.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/01-create-mint.ts
```

**Say:** confidential transfers are just a Token-2022 *extension* — the mint opts in at creation. Point at the three config fields, especially the auditor: set it and one designated party can decrypt every amount — compliance without a public ledger.
**Point at:** the mint on the explorer — `ConfidentialTransferMint` next to ordinary mint data.

### 02 — Configure Alice & Bob · [guide](apps/web/scripts/workshop/02-configure-account.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/02-configure-account.ts
```

**Say:** keys are *derived, not stored* — read the printed message strings aloud; that's literally what Phantom signs in the web app. Configuring publishes the ElGamal pubkey on-chain, which is why recipients must configure before they can receive.
**Point at:** the printed signed-message text; a token account's `ConfidentialTransferAccount` extension on the explorer.

### 03 — Deposit & apply · [guide](apps/web/scripts/workshop/03-deposit-and-apply.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/03-deposit-and-apply.ts
```

**Say:** three balances — watch value flow public → pending → available. Pending exists because only the owner can re-encrypt their own running balance. Be honest: the *deposit* amount is public; privacy starts inside.
**Point at:** the three-balance printout after each stage (1000/0/0 → 500/500/0 → 500/0/500).

### 04 — The confidential transfer · [guide](apps/web/scripts/workshop/04-confidential-transfer.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/04-confidential-transfer.ts
```

**Say:** three proofs (equality: no minting from thin air; validity: same amount encrypted to sender/receiver/auditor; range: no negative amounts). Five transactions because of the 1232-byte limit; context-state accounts are refunded scratch space. Every transaction prints labeled — read the labels aloud.
**Point at:** the final transfer transaction on the explorer — *no amount anywhere*.

### 05 — Bob decrypts · [guide](apps/web/scripts/workshop/05-decrypt.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/workshop/05-decrypt.ts
```

**Say:** the raw base64 block is what *everyone* — explorer, RPC, validators — sees. Bob re-signs the same messages, decrypts pending (slow ElGamal, hence the lo/hi split), applies, and reads his total instantly via AES. Two decryption paths, each existing for a reason.
**Point at:** the outsider-view ciphertext block, then the decrypted amounts right under it. Close the loop with the deployed app showing "encrypted" for the same account.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WebAssembly module is included in initial chunk` / import errors on `@solana/zk-sdk` | You forgot the flag or used bun. Must be `NODE_OPTIONS=--experimental-wasm-modules npx tsx ...` under Node 22+. (The `ExperimentalWarning` about WASM modules is normal — ignore it.) |
| `429 Too Many Requests` / timeouts mid-step | Public devnet RPC rate limit. Set `SOLANA_RPC_URL` in `apps/web/.env` to a dedicated provider (Helius/Triton/QuickNode free tiers are fine). The scripts already pace themselves and poll via HTTP. |
| Airdrop fails repeatedly | Devnet faucet is heavily rate-limited. Fund the payer manually at https://faucet.solana.com and put its key in `FAUCET_PRIVATE_KEY` — don't rely on airdrops during a live session. |
| `state.json is missing "mint" — run 01-create-mint.ts first` | Steps run in order and share `apps/web/scripts/workshop/state.json`. Run the named step, or delete `state.json` and restart from 01. |
| A transaction fails on-chain in step 04 | Usually a stale account snapshot (e.g. you edited balances between fetch and send). Just re-run the step — it re-fetches, re-proves, and uses fresh blockhashes. |
| Payer balance drained | Each full run costs a few hundredths of a SOL (context-account rent is refunded). Top up at the faucet. |
