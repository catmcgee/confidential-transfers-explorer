# CT Explorer - Confidential Transfer Indexer & Explorer

A simple, clean indexer and explorer for Token-2022 Confidential Transfer activity on Solana.

## Features

- **Public Explorer**: View global feed of CT activity with encrypted amounts
- **Address Pages**: See CT activity for any address
- **Wallet Integration**: Connect via Wallet Standard
- **Client-Side Decryption**: Unlock your own data with your decryption keys (keys never leave browser)
- **REST API**: Programmatic access for wallets and businesses

## Architecture

```
ct-explorer/
├── apps/
│   ├── indexer/     # Node service that indexes chain → SQLite
│   └── web/         # Next.js app serving UI + API
├── packages/
│   └── shared/      # Shared types, schemas, constants
└── data/            # SQLite database (created at runtime)
```

## Tech Stack

- **Frontend**: Next.js 15, React 19, Tailwind CSS
- **Backend**: Next.js API Routes
- **Indexer**: Bun with @solana/rpc (Anza Kit)
- **Database**: SQLite via better-sqlite3
- **Auth**: JWT sessions with wallet signature verification

## Getting Started

### Prerequisites

- Bun 1.0+
- A Solana wallet with custom RPC support (Backpack or Solflare recommended)

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd ct-explorer

# Install dependencies
bun install

# Build shared package
bun run build:shared
```

### Environment Setup

```bash
# Copy environment files
cp .env.example .env
cp apps/indexer/.env.example apps/indexer/.env
cp apps/web/.env.example apps/web/.env

# Edit .env files as needed (defaults work for local dev)
```

### Database Setup

```bash
# Initialize database with schema
bun run db:migrate

# Optional: Add sample data for testing
bun run db:seed
```

### Running the Application

#### Development (two terminals)

Terminal 1 - Indexer:
```bash
bun run dev:indexer
```

Terminal 2 - Web App:
```bash
bun run dev:web
```

Open http://localhost:3000

#### Production Build

```bash
# Build all packages
bun run build

# Run indexer
cd apps/indexer && bun run start

# Run web (in another terminal)
cd apps/web && bun run start
```

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

## Client-Side Decryption

The decryption feature allows users to view their own encrypted data:

1. **Key Material**: Users provide their ElGamal secret key (derived from wallet signature)
2. **Local Storage**: Key is stored encrypted in browser localStorage
3. **Decryption**: All decryption happens client-side using WebCrypto

### Key Derivation

To derive your ElGamal secret key, sign the message `"ElGamalSecretKey"` with your wallet using your token account address as context. The resulting signature is used to derive the key.

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

- **Keys Never Leave Browser**: Decryption key material is never sent to the server
- **Signature Verification**: Login requires signing a timestamped message
- **Session Tokens**: JWTs are httpOnly cookies with 24h expiration
- **Read-Only Database**: Web app opens database in read-only mode

## Development

### Project Scripts

```bash
bun run dev:web          # Start web app in dev mode
bun run dev:indexer      # Start indexer in dev mode
bun run build            # Build all packages
bun run build:shared     # Build shared package only
bun run lint             # Lint all packages
bun run format           # Format code with Prettier
bun run typecheck        # Run TypeScript type checking
bun run db:migrate       # Run database migrations
bun run db:seed          # Seed database with sample data
```

### Adding New Features

1. Add shared types to `packages/shared/src/types.ts`
2. Add API routes in `apps/web/src/app/api/`
3. Add UI components in `apps/web/src/components/`
4. Add hooks in `apps/web/src/hooks/`

## License

MIT
