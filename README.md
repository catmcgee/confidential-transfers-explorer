# CT Explorer - Confidential Transfer Indexer & Explorer

A simple, clean indexer and explorer for Token-2022 Confidential Transfer activity on Solana devnet.

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
│   ├── indexer/     # Node service that indexes chain → SQLite
│   └── web/         # Next.js app serving UI + API
├── packages/
│   └── shared/      # Shared types, schemas, constants
├── scripts/         # Mint setup scripts
└── data/            # SQLite database (created at runtime)
```

All ZK proof generation happens client-side in TypeScript/WebAssembly via
`@solana/zk-sdk` — no separate proof server is required. (The legacy
`rust-ct/` server is no longer used.)

## Tech Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS
- **Backend**: Next.js API Routes
- **Solana**: `@solana/kit` 6.x, `@solana-program/token-2022` 0.12.x
- **ZK Proofs**: `@solana/zk-sdk` 0.4.x (WASM) + the confidential-transfer
  instruction-plan helpers from `@solana-program/token-2022/confidential`
- **Indexer**: Bun with `@solana/kit`
- **Database**: SQLite via better-sqlite3
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

The app supports all confidential transfer operations. On devnet, ZK proofs
do not fit in a single transaction, so operations that need proofs are split
across multiple transactions using **context-state accounts** — each proof
is verified into its own account first, then the token instruction executes,
then the context accounts are closed. This is handled automatically by the
instruction-plan helpers from `@solana-program/token-2022/confidential`.

### 1. Configure Account
Creates the ATA, reallocates it for the CT extension, configures it with
your ElGamal pubkey (derived from a wallet signature), and verifies the
pubkey-validity proof.

### 2. Deposit
Moves tokens from public balance to confidential pending balance.

### 3. Apply Pending Balance
Moves tokens from pending to available confidential balance (required before transfers).

### 4. Confidential Transfer
Sends confidential tokens across several transactions:
1. Create & verify equality proof (context-state account)
2. Create & verify ciphertext-validity proof (context-state account)
3. Create & verify range proof (context-state account)
4. Execute transfer
5. Close context-state accounts (rent refunded)

### 5. Withdraw
Moves tokens from confidential available balance back to public balance
(equality + range proofs via context-state accounts).

## API Endpoints

### Public Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/feed?limit=50&type=all` | Global CT activity feed |
| `GET /api/address/:pubkey?limit=50` | Activity for specific address |
| `GET /api/tx/:sig` | Transaction details |
| `GET /api/mints` | List of tracked mints |

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

The indexer monitors the Token-2022 program for Confidential Transfer extension instructions:

1. **Program ID Filter**: Only processes transactions involving `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`

2. **Instruction Detection**: CT instructions are identified by:
   - First byte: `27` (ConfidentialTransfer extension discriminator)
   - Second byte: Instruction type (InitializeMint=0, Deposit=5, Withdraw=6, Transfer=7, etc.)

3. **Account Resolution**: From/To owners are inferred from:
   - `preTokenBalances`/`postTokenBalances` metadata (preferred)
   - Instruction account positions (fallback)

4. **Ciphertext Extraction**: For transfers, ElGamal ciphertexts are extracted from instruction data and stored as base64.

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
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/e2e-confidential-transfer.ts
```

Notes:
- Must run under Node (not bun) — the ZK SDK ships WASM ES modules.
- Needs a funded devnet key in `FAUCET_PRIVATE_KEY` (apps/web/.env) or a
  successful devnet airdrop (rate-limited).

## Security Notes

- **Keys Never Leave Browser**: encryption keys are derived from wallet signatures client-side
- **Signature Verification**: Login requires signing a timestamped message
- **Session Tokens**: JWTs are httpOnly cookies with 24h expiration
- **Read-Only Database**: Web app opens database in read-only mode

## Development

### Project Scripts

```bash
bun run dev              # Start web app in dev mode (from apps/web)
bun run build            # Build all packages
bun run lint             # Lint all packages
bun run format           # Format code with Prettier
bun run typecheck        # Run TypeScript type checking
bun run setup:mint       # Create a CT-enabled devnet mint
```

### Adding New Features

1. Add shared types to `packages/shared/src/types.ts`
2. Add API routes in `apps/web/src/app/api/`
3. Add UI components in `apps/web/src/components/`

## Troubleshooting

### Devnet airdrop failures
The public devnet faucet is rate-limited. Fund the `FAUCET_PRIVATE_KEY`
wallet at https://faucet.solana.com if airdrops fail.

### "Transaction too large" errors
Confidential transfers must use the multi-transaction context-state flow on
devnet — the instruction-plan helpers do this automatically. If you see this
error, make sure you're using `createTransferPlan`/`createWithdrawPlan`
rather than building a single transaction manually.

### Balance mismatch errors
This usually means the account was configured with different keys. Create a
new account and configure it from the web frontend.

## License

MIT
