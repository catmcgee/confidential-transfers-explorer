# Confidential Transfers Workshop

A hands-on introduction for Solana developers: what Token-2022 Confidential Transfers are, how they work, and how to build with them. You'll use the deployed explorer app on devnet, then look under the hood at each action with a step-by-step guide and a minimal, runnable script.

**How the material fits together:** the [deployed app](https://confidential-transfers-explorer-web.vercel.app) is the production experience — connect a wallet, get faucet tokens, configure, deposit, send, decrypt. Each action has a diagram-first guide in [`workshop/`](workshop/README.md) plus a standalone script that does exactly what the app does, runnable against devnet.

## Links

- Deployed explorer app: https://confidential-transfers-explorer-web.vercel.app
- App source code: https://github.com/catmcgee/confidential-transfers-explorer — the confidential-transfer logic lives in [`apps/web/src/lib/confidentialTransfer.ts`](https://github.com/catmcgee/confidential-transfers-explorer/blob/main/apps/web/src/lib/confidentialTransfer.ts), the UI flows in [`apps/web/src/components/TransferModal.tsx`](https://github.com/catmcgee/confidential-transfers-explorer/blob/main/apps/web/src/components/TransferModal.tsx)
- Solana Explorer (devnet): https://explorer.solana.com/?cluster=devnet — every script prints per-transaction links
- Scripts + per-step guides: [`workshop/`](workshop/README.md)
- Protocol source: [token-2022 confidential transfer extension](https://github.com/solana-program/token-2022/tree/main/program/src/extension/confidential_transfer) · [ZK ElGamal proof program](https://github.com/solana-program/zk-elgamal-proof)

## Suggested order

1. **Start in the app.** Open https://confidential-transfers-explorer-web.vercel.app, connect a devnet wallet, and look at a confidential balance rendering as "encrypted". Sign the two derivation messages and watch it decrypt. That's the punchline up front: *same on-chain bytes, and only the key holder sees a number.*
2. **Read the 3-concept primer** — below. Every step reinforces one of these three ideas.
3. **Work through steps 01–05.** For each one: do the action in the app, read the matching guide to see what just happened under the hood, then optionally run the script to reproduce it end-to-end on devnet. Steps 01–02 are quick; 04 (the transfer itself) is the deepest.

| Step | In the app | Guide |
|---|---|---|
| 01 | The mint behind the faucet (created once by the operator) | [Create the mint](workshop/01-create-mint.md) |
| 02 | The **Configure Confidential** button and its two signature prompts | [Configure an account](workshop/02-configure-account.md) |
| 03 | The **Deposit** and **Apply Pending** buttons | [Deposit & apply](workshop/03-deposit-and-apply.md) |
| 04 | The **Send** flow with its multi-transaction progress bar | [The confidential transfer](workshop/04-confidential-transfer.md) |
| 05 | The **Click to decrypt** balances (and what everyone else sees) | [Decrypt](workshop/05-decrypt.md) |

## The 3-concept primer

Three ideas carry the whole system; everything else is plumbing.

**1. Three balances.** A confidential account holds a normal *public* balance, plus two encrypted ones: *pending* (where incoming credits land — anyone can add to it homomorphically) and *available* (what you can spend — only the owner can rewrite it, by "applying" pending). Pending exists because spending requires proofs over your balance ciphertext, so that ciphertext must not change under your feet while others credit you.

**2. Signature-derived keys.** There are no stored encryption keys. The wallet signs two deterministic, human-readable messages (`ElGamalSecretKey:<owner>:<mint>` and `AeKey:<owner>:<mint>`); the signatures seed an ElGamal keypair and an AES key. Same text → same keys, anywhere, forever. Readable text because wallets like Phantom refuse opaque binary signMessage payloads. Configuring an account publishes the ElGamal *public* key on-chain — that's what senders encrypt to.

**3. Why 5 transactions.** A transfer needs three ZK proofs (equality, ciphertext validity, range). A Solana transaction caps at 1232 bytes; the range proof alone is ~1.5 KB. So each proof is verified into a temporary *context-state* scratch account first, the transfer instruction references all three, and they're closed with rent refunded — all in about five transactions.

## Running the scripts yourself

The app is enough to follow the whole workshop, but the scripts let you reproduce every action locally with nothing hidden. Setup:

- [ ] **Node 22+** installed (`node --version`) — the scripts run under Node via `npx tsx`, *not* bun (the ZK SDK's WASM ESM modules don't load under bun).
- [ ] Dependencies installed at the repo root.
- [ ] `FAUCET_PRIVATE_KEY` set in `apps/web/.env` and funded with **≥ 0.5 devnet SOL** (https://faucet.solana.com). Everything runs off this one payer. (Without it, the scripts fall back to requesting an airdrop, which is heavily rate-limited.)
- [ ] `SOLANA_RPC_URL` set in `apps/web/.env` to a reliable devnet RPC (a dedicated provider beats the public endpoint; the scripts fall back to `https://api.devnet.solana.com`).

Then run the five steps in order (total ≈ 3–4 min of chain time):

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/01-create-mint.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/02-configure-account.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/03-deposit-and-apply.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/04-confidential-transfer.ts
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/05-decrypt.ts
```

Steps share progress through `workshop/state.json` — the mint address and the Alice/Bob test wallets persist between runs, so you can stop and resume anywhere. Delete `state.json` to reset to a fresh mint.

## The steps at a glance

Full explanations live in each step's guide; this is the condensed version.

### 01 — Create the mint · [guide](workshop/01-create-mint.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/01-create-mint.ts
```

Confidential transfers are just a Token-2022 *extension* — the mint opts in at creation. Three config fields matter, especially the auditor: set it and one designated party can decrypt every amount. In the app, this mint already exists — it's the token the faucet hands out.

### 02 — Configure an account · [guide](workshop/02-configure-account.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/02-configure-account.ts
```

Keys are *derived, not stored* — the script prints the exact message strings Phantom asks you to sign in the app. Configuring publishes the ElGamal pubkey on-chain, which is why recipients configure before they can receive.

### 03 — Deposit & apply · [guide](workshop/03-deposit-and-apply.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/03-deposit-and-apply.ts
```

Value flows public → pending → available, matching the app's **Deposit** and **Apply Pending** buttons. The *deposit* amount is public; privacy starts inside. Watch the three-balance printout: 1000/0/0 → 500/500/0 → 500/0/500.

### 04 — The confidential transfer · [guide](workshop/04-confidential-transfer.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/04-confidential-transfer.ts
```

Three proofs (equality, validity, range), five transactions because of the 1232-byte limit, context-state accounts as refunded scratch space — this is what the app's **Send** progress bar counts. The final transaction on the explorer contains *no amount anywhere*.

### 05 — Decrypt · [guide](workshop/05-decrypt.md)

```bash
NODE_OPTIONS=--experimental-wasm-modules npx tsx workshop/05-decrypt.ts
```

The raw base64 block the script prints is what *everyone* — explorer, RPC, validators — sees. The recipient re-signs the same messages, decrypts pending (slow ElGamal), applies, and reads the total instantly via AES. This is the app's **Click to decrypt** end-to-end, plus where the public/confidential boundary sits.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WebAssembly module is included in initial chunk` / import errors on `@solana/zk-sdk` | The flag is missing or you used bun. Must be `NODE_OPTIONS=--experimental-wasm-modules npx tsx ...` under Node 22+. (The `ExperimentalWarning` about WASM modules is normal — ignore it.) |
| `429 Too Many Requests` / timeouts mid-step | Public devnet RPC rate limit. Set `SOLANA_RPC_URL` in `apps/web/.env` to a dedicated provider (Helius/Triton/QuickNode free tiers are fine). The scripts already pace themselves and poll via HTTP. |
| Airdrop fails repeatedly | Devnet faucet is heavily rate-limited. Fund the payer manually at https://faucet.solana.com and put its key in `FAUCET_PRIVATE_KEY` — don't rely on airdrops. |
| `state.json is missing "mint" — run 01-create-mint.ts first` | Steps run in order and share `workshop/state.json`. Run the named step, or delete `state.json` and restart from 01. |
| A transaction fails on-chain in step 04 | Usually a stale account snapshot (e.g. balances changed between fetch and send). Just re-run the step — it re-fetches, re-proves, and uses fresh blockhashes. |
| Payer balance drained | Each full run costs a few hundredths of a SOL (context-account rent is refunded). Top up at the faucet. |
