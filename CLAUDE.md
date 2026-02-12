# Claude Code Project Instructions

## Package Manager
Always use `bun` instead of `npm` or `yarn`:
- `bun install` instead of `npm install`
- `bun add <package>` instead of `npm install <package>`
- `bun run <script>` instead of `npm run <script>`
- `bun dev` instead of `npm run dev`

## Tech Stack
- Monorepo with apps/web (Next.js 15, React 19)
- Tailwind CSS for styling
- Solana Token-2022 with Confidential Transfers
- Custom RPC: https://zk-edge.surfnet.dev:8899

## Development
- Run dev server: `bun dev` (from apps/web)
- The app runs on localhost:3000

## Confidential Transfers
- Uses @solana/zk-sdk for ElGamal crypto and ZK proofs
- Uses @solana/spl-token for Token-2022 instructions
- WebAssembly is enabled in Next.js config
