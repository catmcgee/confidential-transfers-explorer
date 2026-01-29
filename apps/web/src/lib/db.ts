import Database from 'better-sqlite3';
import type { CTActivityRecord, TokenAccountRecord, MintRecord } from '@ct-explorer/shared';

// Database path from environment
const DB_PATH = process.env['DATABASE_PATH'] || './data/ct-explorer.db';

// Lazy database connection
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// Activity queries
export function getFeed(
  limit: number,
  cursor?: number,
  type?: string
): { activities: CTActivityRecord[]; nextCursor: number | null } {
  const database = getDb();

  let query = `
    SELECT
      id, signature, slot, block_time as blockTime, instruction_type as instructionType,
      mint, source_owner as sourceOwner, dest_owner as destOwner,
      source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
      ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
      public_amount as publicAmount, instruction_data as instructionData,
      created_at as createdAt
    FROM ct_activity
    WHERE 1=1
  `;

  const params: Record<string, unknown> = {};

  if (cursor) {
    query += ' AND id < @cursor';
    params['cursor'] = cursor;
  }

  if (type && type !== 'all') {
    query += ' AND instruction_type = @type';
    params['type'] = type;
  }

  query += ' ORDER BY id DESC LIMIT @limit';
  params['limit'] = limit + 1;

  const stmt = database.prepare(query);
  const rows = stmt.all(params) as CTActivityRecord[];

  const hasMore = rows.length > limit;
  const activities = hasMore ? rows.slice(0, -1) : rows;
  const nextCursor = hasMore && activities.length > 0 ? activities[activities.length - 1]!.id : null;

  return { activities, nextCursor };
}

export function getActivityByAddress(
  address: string,
  limit: number,
  cursor?: number,
  type?: string
): { activities: CTActivityRecord[]; nextCursor: number | null } {
  const database = getDb();

  let query = `
    SELECT
      id, signature, slot, block_time as blockTime, instruction_type as instructionType,
      mint, source_owner as sourceOwner, dest_owner as destOwner,
      source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
      ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
      public_amount as publicAmount, instruction_data as instructionData,
      created_at as createdAt
    FROM ct_activity
    WHERE (source_owner = @address OR dest_owner = @address
           OR source_token_account = @address OR dest_token_account = @address)
  `;

  const params: Record<string, unknown> = { address };

  if (cursor) {
    query += ' AND id < @cursor';
    params['cursor'] = cursor;
  }

  if (type && type !== 'all') {
    query += ' AND instruction_type = @type';
    params['type'] = type;
  }

  query += ' ORDER BY id DESC LIMIT @limit';
  params['limit'] = limit + 1;

  const stmt = database.prepare(query);
  const rows = stmt.all(params) as CTActivityRecord[];

  const hasMore = rows.length > limit;
  const activities = hasMore ? rows.slice(0, -1) : rows;
  const nextCursor = hasMore && activities.length > 0 ? activities[activities.length - 1]!.id : null;

  return { activities, nextCursor };
}

export function getActivitiesBySignature(signature: string): CTActivityRecord[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT
      id, signature, slot, block_time as blockTime, instruction_type as instructionType,
      mint, source_owner as sourceOwner, dest_owner as destOwner,
      source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
      ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
      public_amount as publicAmount, instruction_data as instructionData,
      created_at as createdAt
    FROM ct_activity WHERE signature = ?
  `);
  return stmt.all(signature) as CTActivityRecord[];
}

export function getMints(): MintRecord[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT address, decimals, name, symbol, last_seen_slot as lastSeenSlot,
           created_at as createdAt
    FROM mints ORDER BY last_seen_slot DESC
  `);
  return stmt.all() as MintRecord[];
}

export function getMint(address: string): MintRecord | null {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT address, decimals, name, symbol, last_seen_slot as lastSeenSlot,
           created_at as createdAt
    FROM mints WHERE address = ?
  `);
  return stmt.get(address) as MintRecord | null;
}

export function getTokenAccountsByOwner(owner: string): TokenAccountRecord[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT address, mint, owner, last_seen_slot as lastSeenSlot,
           created_at as createdAt, updated_at as updatedAt
    FROM token_accounts WHERE owner = ?
  `);
  return stmt.all(owner) as TokenAccountRecord[];
}

export function search(query: string, limit: number = 10): CTActivityRecord[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT
      id, signature, slot, block_time as blockTime, instruction_type as instructionType,
      mint, source_owner as sourceOwner, dest_owner as destOwner,
      source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
      ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
      public_amount as publicAmount, instruction_data as instructionData,
      created_at as createdAt
    FROM ct_activity
    WHERE signature LIKE @query
       OR source_owner LIKE @query
       OR dest_owner LIKE @query
       OR mint LIKE @query
    ORDER BY id DESC
    LIMIT @limit
  `);
  return stmt.all({ query: `%${query}%`, limit }) as CTActivityRecord[];
}
