import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { CTActivityRecord, TokenAccountRecord, MintRecord } from '@ct-explorer/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DBConfig {
  path: string;
  readonly?: boolean;
}

export class CTDatabase {
  private db: Database;

  constructor(config: DBConfig) {
    this.db = new Database(config.path, {
      readonly: config.readonly ?? false,
      create: !config.readonly,
    });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  // Initialize schema
  migrate(): void {
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    this.db.exec(schema);
    console.log('[DB] Schema migrated successfully');
  }

  // CT Activity operations
  insertActivity(activity: Omit<CTActivityRecord, 'id' | 'createdAt'>): number | null {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ct_activity (
        signature, slot, block_time, instruction_type, mint,
        source_owner, dest_owner, source_token_account, dest_token_account,
        ciphertext_lo, ciphertext_hi, public_amount, instruction_data
      ) VALUES (
        $signature, $slot, $blockTime, $instructionType, $mint,
        $sourceOwner, $destOwner, $sourceTokenAccount, $destTokenAccount,
        $ciphertextLo, $ciphertextHi, $publicAmount, $instructionData
      )
    `);

    const result = stmt.run({
      $signature: activity.signature,
      $slot: activity.slot,
      $blockTime: activity.blockTime,
      $instructionType: activity.instructionType,
      $mint: activity.mint,
      $sourceOwner: activity.sourceOwner,
      $destOwner: activity.destOwner,
      $sourceTokenAccount: activity.sourceTokenAccount,
      $destTokenAccount: activity.destTokenAccount,
      $ciphertextLo: activity.ciphertextLo,
      $ciphertextHi: activity.ciphertextHi,
      $publicAmount: activity.publicAmount,
      $instructionData: activity.instructionData,
    });

    return result.changes > 0 ? Number(result.lastInsertRowid) : null;
  }

  getActivityBySignature(signature: string): CTActivityRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        id, signature, slot, block_time as blockTime, instruction_type as instructionType,
        mint, source_owner as sourceOwner, dest_owner as destOwner,
        source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
        ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
        public_amount as publicAmount, instruction_data as instructionData,
        created_at as createdAt
      FROM ct_activity WHERE signature = $signature
    `);
    return stmt.get({ $signature: signature }) as CTActivityRecord | null;
  }

  getActivitiesBySignature(signature: string): CTActivityRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        id, signature, slot, block_time as blockTime, instruction_type as instructionType,
        mint, source_owner as sourceOwner, dest_owner as destOwner,
        source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
        ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
        public_amount as publicAmount, instruction_data as instructionData,
        created_at as createdAt
      FROM ct_activity WHERE signature = $signature
    `);
    return stmt.all({ $signature: signature }) as CTActivityRecord[];
  }

  getFeed(
    limit: number,
    cursor?: number,
    type?: string
  ): { activities: CTActivityRecord[]; nextCursor: number | null } {
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
      query += ' AND id < $cursor';
      params['$cursor'] = cursor;
    }

    if (type && type !== 'all') {
      query += ' AND instruction_type = $type';
      params['$type'] = type;
    }

    query += ' ORDER BY id DESC LIMIT $limit';
    params['$limit'] = limit + 1;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(params) as CTActivityRecord[];

    const hasMore = rows.length > limit;
    const activities = hasMore ? rows.slice(0, -1) : rows;
    const nextCursor = hasMore && activities.length > 0 ? activities[activities.length - 1]!.id : null;

    return { activities, nextCursor };
  }

  getActivityByAddress(
    address: string,
    limit: number,
    cursor?: number,
    type?: string
  ): { activities: CTActivityRecord[]; nextCursor: number | null } {
    let query = `
      SELECT
        id, signature, slot, block_time as blockTime, instruction_type as instructionType,
        mint, source_owner as sourceOwner, dest_owner as destOwner,
        source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
        ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
        public_amount as publicAmount, instruction_data as instructionData,
        created_at as createdAt
      FROM ct_activity
      WHERE (source_owner = $address OR dest_owner = $address
             OR source_token_account = $address OR dest_token_account = $address)
    `;

    const params: Record<string, unknown> = { $address: address };

    if (cursor) {
      query += ' AND id < $cursor';
      params['$cursor'] = cursor;
    }

    if (type && type !== 'all') {
      query += ' AND instruction_type = $type';
      params['$type'] = type;
    }

    query += ' ORDER BY id DESC LIMIT $limit';
    params['$limit'] = limit + 1;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(params) as CTActivityRecord[];

    const hasMore = rows.length > limit;
    const activities = hasMore ? rows.slice(0, -1) : rows;
    const nextCursor = hasMore && activities.length > 0 ? activities[activities.length - 1]!.id : null;

    return { activities, nextCursor };
  }

  // Token account operations
  upsertTokenAccount(account: Omit<TokenAccountRecord, 'createdAt' | 'updatedAt'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO token_accounts (address, mint, owner, last_seen_slot)
      VALUES ($address, $mint, $owner, $lastSeenSlot)
      ON CONFLICT(address) DO UPDATE SET
        mint = $mint,
        owner = $owner,
        last_seen_slot = MAX(last_seen_slot, $lastSeenSlot),
        updated_at = datetime('now')
    `);
    stmt.run({
      $address: account.address,
      $mint: account.mint,
      $owner: account.owner,
      $lastSeenSlot: account.lastSeenSlot,
    });
  }

  getTokenAccountsByOwner(owner: string): TokenAccountRecord[] {
    const stmt = this.db.prepare(`
      SELECT address, mint, owner, last_seen_slot as lastSeenSlot,
             created_at as createdAt, updated_at as updatedAt
      FROM token_accounts WHERE owner = $owner
    `);
    return stmt.all({ $owner: owner }) as TokenAccountRecord[];
  }

  // Mint operations
  upsertMint(mint: Omit<MintRecord, 'createdAt'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO mints (address, decimals, name, symbol, last_seen_slot)
      VALUES ($address, $decimals, $name, $symbol, $lastSeenSlot)
      ON CONFLICT(address) DO UPDATE SET
        decimals = $decimals,
        name = COALESCE($name, name),
        symbol = COALESCE($symbol, symbol),
        last_seen_slot = MAX(last_seen_slot, $lastSeenSlot)
    `);
    stmt.run({
      $address: mint.address,
      $decimals: mint.decimals,
      $name: mint.name,
      $symbol: mint.symbol,
      $lastSeenSlot: mint.lastSeenSlot,
    });
  }

  getMints(): MintRecord[] {
    const stmt = this.db.prepare(`
      SELECT address, decimals, name, symbol, last_seen_slot as lastSeenSlot,
             created_at as createdAt
      FROM mints ORDER BY last_seen_slot DESC
    `);
    return stmt.all() as MintRecord[];
  }

  getMint(address: string): MintRecord | null {
    const stmt = this.db.prepare(`
      SELECT address, decimals, name, symbol, last_seen_slot as lastSeenSlot,
             created_at as createdAt
      FROM mints WHERE address = $address
    `);
    return stmt.get({ $address: address }) as MintRecord | null;
  }

  // Indexer state operations
  getState(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM indexer_state WHERE key = $key');
    const row = stmt.get({ $key: key }) as { value: string } | null;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO indexer_state (key, value, updated_at)
      VALUES ($key, $value, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = $value,
        updated_at = datetime('now')
    `);
    stmt.run({ $key: key, $value: value });
  }

  getLastProcessedSlot(): number {
    const value = this.getState('last_processed_slot');
    return value ? parseInt(value, 10) : 0;
  }

  setLastProcessedSlot(slot: number): void {
    this.setState('last_processed_slot', slot.toString());
  }

  getLastProcessedSignature(): string | null {
    return this.getState('last_processed_signature') || null;
  }

  setLastProcessedSignature(signature: string): void {
    this.setState('last_processed_signature', signature);
  }

  incrementActivityCount(count: number = 1): void {
    const current = parseInt(this.getState('total_activities_indexed') || '0', 10);
    this.setState('total_activities_indexed', (current + count).toString());
  }

  getTotalActivityCount(): number {
    return parseInt(this.getState('total_activities_indexed') || '0', 10);
  }

  // Check if signature exists
  signatureExists(signature: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM ct_activity WHERE signature = $signature LIMIT 1');
    return stmt.get({ $signature: signature }) !== null;
  }

  // Search - returns activities matching signature or address
  search(query: string, limit: number = 10): CTActivityRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        id, signature, slot, block_time as blockTime, instruction_type as instructionType,
        mint, source_owner as sourceOwner, dest_owner as destOwner,
        source_token_account as sourceTokenAccount, dest_token_account as destTokenAccount,
        ciphertext_lo as ciphertextLo, ciphertext_hi as ciphertextHi,
        public_amount as publicAmount, instruction_data as instructionData,
        created_at as createdAt
      FROM ct_activity
      WHERE signature LIKE $query
         OR source_owner LIKE $query
         OR dest_owner LIKE $query
         OR mint LIKE $query
      ORDER BY id DESC
      LIMIT $limit
    `);
    return stmt.all({ $query: `%${query}%`, $limit: limit }) as CTActivityRecord[];
  }

  close(): void {
    this.db.close();
  }
}

// Singleton database instance
let dbInstance: CTDatabase | null = null;

export function getDatabase(config?: DBConfig): CTDatabase {
  if (!dbInstance) {
    if (!config) {
      throw new Error('Database not initialized. Provide config on first call.');
    }
    dbInstance = new CTDatabase(config);
  }
  return dbInstance;
}
