-- CT Explorer Database Schema
-- SQLite schema for indexing Confidential Transfer activity

-- Table: ct_activity
-- Stores all indexed Confidential Transfer activities
CREATE TABLE IF NOT EXISTS ct_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signature TEXT NOT NULL UNIQUE,
    slot INTEGER NOT NULL,
    block_time INTEGER,
    instruction_type TEXT NOT NULL DEFAULT 'Unknown',
    mint TEXT,
    source_owner TEXT,
    dest_owner TEXT,
    source_token_account TEXT,
    dest_token_account TEXT,
    -- Encrypted amount ciphertexts (base64 encoded)
    ciphertext_lo TEXT,
    ciphertext_hi TEXT,
    -- For deposits/withdrawals, the public (non-encrypted) amount
    public_amount TEXT,
    -- Raw instruction data for future parsing improvements
    instruction_data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- Indexes for common queries
    CONSTRAINT chk_instruction_type CHECK (
        instruction_type IN (
            'InitializeMint', 'UpdateMint', 'ConfigureAccount', 'ApproveAccount',
            'EmptyAccount', 'Deposit', 'Withdraw', 'Transfer', 'ApplyPendingBalance',
            'EnableConfidentialCredits', 'DisableConfidentialCredits',
            'EnableNonConfidentialCredits', 'DisableNonConfidentialCredits',
            'TransferWithSplitProofs', 'TransferWithFee', 'Unknown'
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_ct_activity_slot ON ct_activity(slot DESC);
CREATE INDEX IF NOT EXISTS idx_ct_activity_block_time ON ct_activity(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_ct_activity_source_owner ON ct_activity(source_owner);
CREATE INDEX IF NOT EXISTS idx_ct_activity_dest_owner ON ct_activity(dest_owner);
CREATE INDEX IF NOT EXISTS idx_ct_activity_mint ON ct_activity(mint);
CREATE INDEX IF NOT EXISTS idx_ct_activity_type ON ct_activity(instruction_type);

-- Table: token_accounts
-- Tracks token accounts involved in CT activity
CREATE TABLE IF NOT EXISTS token_accounts (
    address TEXT PRIMARY KEY,
    mint TEXT NOT NULL,
    owner TEXT NOT NULL,
    last_seen_slot INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_token_accounts_owner ON token_accounts(owner);
CREATE INDEX IF NOT EXISTS idx_token_accounts_mint ON token_accounts(mint);

-- Table: mints
-- Stores information about mints with CT enabled
CREATE TABLE IF NOT EXISTS mints (
    address TEXT PRIMARY KEY,
    decimals INTEGER NOT NULL DEFAULT 9,
    name TEXT,
    symbol TEXT,
    last_seen_slot INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Table: indexer_state
-- Tracks indexer progress and metadata
CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize indexer state
INSERT OR IGNORE INTO indexer_state (key, value) VALUES ('last_processed_slot', '0');
INSERT OR IGNORE INTO indexer_state (key, value) VALUES ('last_processed_signature', '');
INSERT OR IGNORE INTO indexer_state (key, value) VALUES ('total_activities_indexed', '0');
