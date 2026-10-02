# Claude Code Project Instructions

## Package Manager
Always use `bun` instead of `npm` or `yarn`:
- `bun install` instead of `npm install`
- `bun add <package>` instead of `npm install <package>`
- `bun run <script>` instead of `npm run <script>`
- `bun dev` instead of `npm run dev`

Exception: test scripts that load the ZK SDK's WebAssembly must run under
Node (bun cannot load the WASM ESM modules):
`NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/e2e-confidential-transfer.ts`

## Tech Stack
- Monorepo with apps/web (Next.js 15, React 19)
- Tailwind CSS for styling
- Solana Token-2022 with Confidential Transfers
- Network: Solana devnet (https://api.devnet.solana.com)

## Development
- Run dev server: `bun dev` (from apps/web)
- No indexer/database: the explorer is fully RPC-driven (feed anchors on the ZK ElGamal Proof Program); API routes set CDN cache headers for Vercel
- The app runs on localhost:3000

## Confidential Transfers
- Uses @solana/zk-sdk (0.5.x) for ElGamal crypto and ZK proofs
- Uses @solana-program/token-2022 (0.19.x) — including the high-level
  helpers from `@solana-program/token-2022/confidential` (instruction plans
  that generate proofs and verify them via context-state accounts)
- Uses @solana/kit (8.x) for RPC and transaction building
- All transactions are VERSION 1 (4096-byte limit): a transfer or withdrawal
  is ONE transaction. v1 budgets zero compute units / loaded-account bytes
  unless set, so messages get provisory limits at planning time and are
  simulated (`estimateAndSetResourceLimitsFactory`) before signing.
  Wallets that don't list v1 in `supportedTransactionVersions` fall back to
  v0 (multi-transaction).
- Fetch transactions with `maxSupportedTransactionVersion: 1` — the RPC
  rejects v1 transactions when the cap is 0
- ElGamal/AES keys come from `src/lib/ctKeyDerivation.ts`, which reproduces
  zk-sdk 0.4's `fromSignature` (removed in 0.5). Never switch to 0.5's
  `ConfidentialKeys.fromSignature` — it derives different keys and would
  strand existing encrypted balances
- WebAssembly is enabled in Next.js config
