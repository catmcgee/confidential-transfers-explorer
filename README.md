# CT Explorer - Confidential Transfer Indexer & Explorer

A simple, clean indexer and explorer for Token-2022 Confidential Transfer activity on Solana.

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
├── rust-ct/         # Rust API server for ZK proof generation
├── packages/
│   └── shared/      # Shared types, schemas, constants
└── data/            # SQLite database (created at runtime)
```

## Tech Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS
- **Backend**: Next.js API Routes
- **ZK Proofs**: Rust API server using `spl-token-2022` and `solana-zk-sdk`
- **Indexer**: Bun with @solana/rpc (Anza Kit)
- **Database**: SQLite via better-sqlite3
- **Auth**: JWT sessions with wallet signature verification

## Getting Started

### Prerequisites

- Bun 1.0+
- Rust 1.70+ (for the ZK proof API server)
- A Solana wallet with custom RPC support (Backpack or Solflare recommended)

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd conf-transfers-explorer

# Install JavaScript dependencies
bun install

# Build Rust API server
cd rust-ct && cargo build --release
```

### Environment Setup

```bash
# Copy environment files
cp apps/web/.env.example apps/web/.env

# Edit .env files as needed (defaults work for local dev)
# Key environment variables:
# - NEXT_PUBLIC_SOLANA_RPC_URL: Solana RPC endpoint (default: https://zk-edge.surfnet.dev:8899)
# - NEXT_PUBLIC_RUST_API_URL: Rust API endpoint (default: http://localhost:3002)
```

### Running the Application

You need to run **two services**:

#### Terminal 1 - Rust API Server (ZK Proofs)

```bash
cd rust-ct
cargo run --bin api-server
```

This starts the Rust API on http://localhost:3002 which handles:
- ElGamal key derivation
- ZK proof generation for transfers
- Balance encryption/decryption

#### Terminal 2 - Web App

```bash
cd apps/web
bun dev
```

Open http://localhost:3000

### Quick Start (Both Services)

```bash
# In one terminal, start both services:
cd rust-ct && cargo run --bin api-server &
cd apps/web && bun dev
```

## Confidential Transfer Operations

The app supports all confidential transfer operations:

### 1. Configure Account
Enables confidential transfers on a token account by:
- Deriving ElGamal keypair from wallet signature
- Generating pubkey validity proof
- Reallocating account space for CT extension

### 2. Deposit
Moves tokens from public balance to confidential pending balance.

### 3. Apply Pending Balance
Moves tokens from pending to available confidential balance (required before transfers).

### 4. Confidential Transfer
Sends confidential tokens using 5 split-proof transactions:
1. Create & verify equality proof
2. Create & verify validity proof
3. Create range proof context
4. Verify range proof
5. Execute transfer & close contexts

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

### Rust API Endpoints (localhost:3002)

| Endpoint | Description |
|----------|-------------|
| `POST /derive-keys` | Derive ElGamal pubkey from wallet signature |
| `POST /generate-pubkey-validity-proof` | Generate proof for Configure CT |
| `POST /encrypt-balance` | Encrypt balance with AES (for Apply Pending) |
| `POST /decrypt-balance` | Decrypt pending/available balances |
| `POST /generate-transfer-proofs` | Generate all ZK proofs for transfer |
| `POST /account-info` | Get account info with decrypted balances |
| `GET /health` | Health check |

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

Keys are derived from wallet signatures (never leave the browser):

1. **ElGamal Key**: Sign message `"ElGamalSecretKey" + tokenAccountAddress`
2. **AES Key**: Sign message `"AeKey" + tokenAccountAddress`

These signatures are sent to the Rust API which derives the actual cryptographic keys using the same algorithm as the Solana CLI.

## Wallet Setup (Custom RPC)

To interact with a custom Solana network like zk-edge, you need a wallet that supports custom RPC:

### Backpack (Recommended)
1. Open Settings (top right)
2. Paste your RPC URL in the RPC field (e.g., `https://zk-edge.surfnet.dev:8899`)
3. Click "Switch"

### Solflare
1. Go to Settings (bottom right)
2. Click "Network" → "Add Custom Node"
3. Enter a name and your RPC URL
4. Click Save → Proceed

**Note:** Phantom does not support custom RPCs.

## Security Notes

- **Keys Never Leave Browser**: Only signatures are sent to the Rust API, which derives keys locally
- **Signature Verification**: Login requires signing a timestamped message
- **Session Tokens**: JWTs are httpOnly cookies with 24h expiration
- **Read-Only Database**: Web app opens database in read-only mode

## Development

### Project Scripts

```bash
bun run dev              # Start web app in dev mode (from apps/web)
cargo run --bin api-server  # Start Rust API (from rust-ct)
bun run build            # Build all packages
bun run lint             # Lint all packages
bun run format           # Format code with Prettier
bun run typecheck        # Run TypeScript type checking
```

### Adding New Features

1. Add shared types to `packages/shared/src/types.ts`
2. Add API routes in `apps/web/src/app/api/`
3. Add UI components in `apps/web/src/components/`
4. Add Rust endpoints in `rust-ct/src/bin/api_server.rs`

## Troubleshooting

### "Failed to derive keys" or API errors
Make sure the Rust API server is running on port 3002:
```bash
cd rust-ct && cargo run --bin api-server
```

### Transaction too large errors
The zk-edge RPC supports larger transactions (4KB) needed for ZK proofs. Make sure your wallet is connected to `https://zk-edge.surfnet.dev:8899`.

### Balance mismatch errors
This usually means the account was configured with different keys. Create a new account and configure it from the web frontend.

## License

MIT
