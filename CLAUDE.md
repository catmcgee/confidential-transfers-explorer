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
- The app runs on localhost:3000

## Confidential Transfers
- Uses @solana/zk-sdk (0.4.x) for ElGamal crypto and ZK proofs
- Uses @solana-program/token-2022 (0.12.x) — including the high-level
  helpers from `@solana-program/token-2022/confidential` (instruction plans
  that generate proofs and verify them via context-state accounts)
- Uses @solana/kit (6.x) for RPC and transaction building; kit is pinned to
  6.x because token-2022 0.12 peer-depends on kit ^6.4
- Transfers/withdrawals span MULTIPLE transactions on devnet (proofs are
  verified into context-state accounts first) — this is expected
- WebAssembly is enabled in Next.js config
