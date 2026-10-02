# CT Explorer - Confidential Transfer Explorer

A simple, clean explorer for Token-2022 Confidential Transfer activity on Solana devnet. Fully RPC-driven — no indexer, no database.

## Features

- **Public Explorer**: View global feed of CT activity with encrypted amounts
- **Address Pages**: See CT activity for any address
- **Wallet Integration**: Connect via Wallet Standard
- **Confidential Transfers**: Full support for ZK proof-based confidential transfers
- **Client-Side Decryption**: Unlock your own data with wallet signatures
- **REST API**: Programmatic access for wallets and businesses

## Architecture

```
conf-transfers-explorer/
├── apps/
│   └── web/         # Next.js app serving UI + API (RPC-only, no DB)
├── packages/
│   └── shared/      # Shared types, schemas, constants
└── scripts/         # Mint setup scripts
```

- **No indexer**: all data comes straight from the Solana RPC. The global
  feed anchors its scan on the ZK ElGamal Proof Program
  (`ZkE1Gama1Proof11111111111111111111111111111`) — it's referenced almost
  exclusively by confidential-transfer flows, so its signature history is a
  concentrated CT feed even on busy public clusters.
- **Caching for Vercel**: API responses carry `Cache-Control: s-maxage` +
  `stale-while-revalidate` headers so Vercel's edge CDN serves repeat
  requests without touching the RPC. Transaction details (immutable) are
  cached for a day at the edge. An in-memory cache dedupes RPC work within
  warm serverless instances.
- **ZK proofs**: generated client-side in TypeScript/WebAssembly via
  `@solana/zk-sdk` — no proof server.

## Tech Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS
- **Backend**: Next.js API Routes (stateless, RPC-only)
- **Solana**: `@solana/kit` 8.x (version 1 transactions), `@solana-program/token-2022` 0.19.x
- **ZK Proofs**: `@solana/zk-sdk` 0.5.x (WASM) + the confidential-transfer
  instruction-plan helpers from `@solana-program/token-2022/confidential`
- **Auth**: JWT sessions with wallet signature verification

## Getting Started

### Prerequisites

- Bun 1.0+
- Node 22+ (for the e2e test script — the ZK SDK's WASM modules need Node)
- A Solana wallet (Phantom, Backpack, or Solflare) set to devnet

### Installation

```bash
git clone <repo-url>
cd conf-transfers-explorer
bun install
```

### Environment Setup

```bash
cp apps/web/.env.example apps/web/.env

# Key environment variables:
# - NEXT_PUBLIC_SOLANA_RPC_URL: Solana RPC endpoint (default: https://api.devnet.solana.com)
# - FAUCET_PRIVATE_KEY: funded devnet keypair for the faucet & mint scripts
```

### Running the Application

```bash
cd apps/web
bun dev
```

Open http://localhost:3000

### Creating a CT-enabled mint

```bash
bun run setup:mint   # creates a Token-2022 mint with the CT extension on devnet
```

## Confidential Transfer Operations

The app supports all confidential transfer operations. Operations that need
proofs use **context-state accounts**: each proof is verified into its own
account, the token instruction executes, then the context accounts are
closed. The app sends **version 1 transactions** (4096-byte limit vs 1232 for
legacy/v0), so a whole transfer or withdrawal fits in **one transaction**.
This is handled by the instruction-plan helpers from
`@solana-program/token-2022/confidential` plus kit's transaction planner.

If a connected wallet doesn't advertise v1 support (wallet-standard
`supportedTransactionVersions`), the app falls back to v0 and the same plan
is split across ~5 transactions.

### 1. Configure Account
Creates the ATA, reallocates it for the CT extension, configures it with
your ElGamal pubkey (derived from a wallet signature), and verifies the
pubkey-validity proof.

### 2. Deposit
Moves tokens from public balance to confidential pending balance.

### 3. Apply Pending Balance
Moves tokens from pending to available confidential balance (required before transfers).

### 4. Confidential Transfer
Sends confidential tokens in a single v1 transaction (~2.9 KB) that:
1. Creates & verifies the equality proof (context-state account)
2. Creates & verifies the ciphertext-validity proof (context-state account)
3. Creates & verifies the range proof (context-state account)
4. Executes the transfer
5. Closes the context-state accounts (rent refunded)

### 5. Withdraw
Moves tokens from confidential available balance back to public balance
(equality + range proofs via context-state accounts, in one v1 transaction).

## API Endpoints

All public endpoints are CDN-cacheable (`s-maxage` + `stale-while-revalidate`).

### Public Endpoints

| Endpoint | Description | Edge cache |
|----------|-------------|------------|
| `GET /api/feed?limit=50&type=all` | Global CT activity feed | 30s (+SWR 5m) |
| `GET /api/address/:pubkey?limit=50` | Activity for specific address | 30s (+SWR 5m) |
| `GET /api/tx/:sig` | Transaction details (immutable) | 24h (+SWR 7d) |
| `GET /api/mints` | Recently active CT mints | 5m (+SWR 15m) |

### Authenticated Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/me/activity` | Activity for logged-in user |
| `GET /api/me/balances` | Token accounts for logged-in user |

### Auth Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/auth/login` | Login with wallet signature |
| `POST /api/auth/logout` | Clear session |
| `GET /api/auth/session` | Check current session |

### Faucet Endpoint

| Endpoint | Description |
|----------|-------------|
| `POST /api/faucet` | Request test tokens (devnet only) |

## How CT Data is Detected

1. **Feed scan anchor**: the global feed lists signatures of the ZK ElGamal
   Proof Program. Proof verification / context-state closing happen in the
   same transactions as (or adjacent to) the CT instructions, so nearly
   every signature is CT-related — unlike the Token-2022 program, whose
   devnet history is dominated by unrelated token traffic.

2. **Instruction Detection**: within each transaction, CT instructions on
   `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` are identified by:
   - First byte: `27` (ConfidentialTransfer extension discriminator)
   - Second byte: Instruction type (InitializeMint=0, Deposit=5, Withdraw=6, Transfer=7, etc.)

3. **Account Resolution**: From/To owners are inferred from
   `preTokenBalances`/`postTokenBalances` metadata, falling back to
   instruction account positions.

4. **Address pages** scan the address's own signature history, which
   includes deposits and apply-pending operations that never touch the ZK
   proof program.

## Client-Side Key Derivation

Keys are derived from wallet signatures (they never leave the browser),
using the official derivation from `@solana-program/token-2022/confidential`:

1. **ElGamal Key**: the wallet signs a domain-separated message seeded with
   `(owner, mint)`; the signature seeds the keypair
2. **AES Key**: same flow with the AES domain separator

Because keys are bound to `(owner, mint)` rather than the token account
address, they remain stable if a token account is closed and reopened.

## Testing

An end-to-end test runs the entire flow (create mint → configure accounts →
deposit → apply → confidential transfer → withdraw) against devnet:

```bash
cd apps/web && bun run test:e2e
# or directly:
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/e2e-confidential-transfer.ts
```

Notes:
- Must run under Node (not bun) — the ZK SDK ships WASM ES modules.
- Needs a funded devnet key in `FAUCET_PRIVATE_KEY` (apps/web/.env) or a
  successful devnet airdrop (rate-limited).

## Deployment (Vercel)

The app is a single Next.js project (`apps/web`) with no database or
long-running services — it deploys straight to Vercel. Set:

- `NEXT_PUBLIC_SOLANA_RPC_URL` — use a dedicated RPC (Helius/QuickNode/Triton)
  in production; the public devnet endpoint rate-limits aggressively
- `NEXT_PUBLIC_NETWORK_NAME=devnet`
- `JWT_SECRET`, `FAUCET_PRIVATE_KEY`, `CT_FAUCET_MINT` (for the faucet)

The CDN cache headers keep RPC usage low: repeat feed views hit the edge
cache, and immutable transaction lookups are cached for a day.

## Security Notes

- **Keys Never Leave Browser**: encryption keys are derived from wallet signatures client-side
- **Signature Verification**: Login requires signing a timestamped message
- **Session Tokens**: JWTs are httpOnly cookies with 24h expiration

## Troubleshooting

### Devnet airdrop failures
The public devnet faucet is rate-limited. Fund the `FAUCET_PRIVATE_KEY`
wallet at https://faucet.solana.com if airdrops fail.

### Slow or empty feed
The public devnet RPC rate-limits scan queries. Use a dedicated RPC via
`NEXT_PUBLIC_SOLANA_RPC_URL` for consistently fast feeds.

### Balance mismatch errors
This usually means the account was configured with different keys. Create a
new account and configure it from the web frontend.

## License

MIT
