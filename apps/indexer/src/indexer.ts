import { address } from '@solana/addresses';
import { TOKEN_2022_PROGRAM_ID } from '@ct-explorer/shared';
import type { IndexerConfig } from './config.js';
import { getRpcClient, type SolanaClient } from './rpc/client.js';
import { CTDatabase, getDatabase } from './db/database.js';
import { parseTransaction, mightContainCT } from './parser/tx-parser.js';

export class CTIndexer {
  private rpc: SolanaClient;
  private db: CTDatabase;
  private config: IndexerConfig;
  private isRunning: boolean = false;
  private lastSignature: string | null = null;

  constructor(config: IndexerConfig) {
    this.config = config;
    this.rpc = getRpcClient(config);
    this.db = getDatabase({ path: config.databasePath });
  }

  /**
   * Start the indexer
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.lastSignature = this.db.getLastProcessedSignature();

    console.log('[Indexer] Starting...');
    console.log(`[Indexer] RPC: ${this.config.rpcUrl}`);
    console.log(`[Indexer] Last signature: ${this.lastSignature || 'none'}`);

    // Initial backfill if no signatures processed
    if (!this.lastSignature) {
      console.log(`[Indexer] Running initial backfill (${this.config.backfillSignatures} signatures)...`);
      await this.backfill(this.config.backfillSignatures);
    }

    // Main polling loop
    await this.pollLoop();
  }

  /**
   * Stop the indexer
   */
  stop(): void {
    this.isRunning = false;
    console.log('[Indexer] Stopping...');
  }

  /**
   * Backfill historical signatures
   */
  private async backfill(count: number): Promise<void> {
    console.log(`[Indexer] Backfilling last ${count} Token-2022 signatures...`);

    try {
      // Get recent signatures for Token-2022 program
      const response = await this.rpc
        .getSignaturesForAddress(address(TOKEN_2022_PROGRAM_ID), {
          limit: count,
        })
        .send();

      const signatures = response;
      console.log(`[Indexer] Found ${signatures.length} signatures to process`);

      // Process in batches
      let processed = 0;
      let indexed = 0;

      for (let i = 0; i < signatures.length; i += this.config.batchSize) {
        if (!this.isRunning) break;

        const batch = signatures.slice(i, i + this.config.batchSize);
        const results = await this.processBatch(batch.map((s) => s.signature));

        processed += batch.length;
        indexed += results.indexed;

        if (processed % 100 === 0) {
          console.log(`[Indexer] Backfill progress: ${processed}/${signatures.length} (${indexed} CT activities)`);
        }
      }

      // Update last signature
      if (signatures.length > 0 && signatures[0]) {
        this.lastSignature = signatures[0].signature;
        this.db.setLastProcessedSignature(this.lastSignature);
      }

      console.log(`[Indexer] Backfill complete. Indexed ${indexed} CT activities from ${processed} transactions.`);
    } catch (error) {
      console.error('[Indexer] Backfill error:', error);
    }
  }

  /**
   * Main polling loop for new transactions
   */
  private async pollLoop(): Promise<void> {
    console.log('[Indexer] Starting poll loop...');

    while (this.isRunning) {
      try {
        await this.pollNewSignatures();
      } catch (error) {
        console.error('[Indexer] Poll error:', error);
      }

      // Wait before next poll
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  /**
   * Poll for new signatures since last processed
   */
  private async pollNewSignatures(): Promise<void> {
    try {
      const options: Record<string, unknown> = {
        limit: this.config.batchSize,
      };

      if (this.lastSignature) {
        options['until'] = this.lastSignature;
      }

      const response = await this.rpc
        .getSignaturesForAddress(address(TOKEN_2022_PROGRAM_ID), options as Parameters<typeof this.rpc.getSignaturesForAddress>[1])
        .send();

      const signatures = response;

      if (signatures.length === 0) {
        return;
      }

      // Process new signatures (they come in reverse chronological order)
      const results = await this.processBatch(signatures.map((s) => s.signature));

      if (results.indexed > 0) {
        console.log(`[Indexer] Indexed ${results.indexed} new CT activities`);
      }

      // Update last signature to newest
      if (signatures.length > 0 && signatures[0]) {
        this.lastSignature = signatures[0].signature;
        this.db.setLastProcessedSignature(this.lastSignature);
      }
    } catch (error) {
      console.error('[Indexer] Error polling signatures:', error);
    }
  }

  /**
   * Process a batch of signatures
   */
  private async processBatch(signatures: string[]): Promise<{ processed: number; indexed: number }> {
    let processed = 0;
    let indexed = 0;

    for (const signature of signatures) {
      // Skip if already processed
      if (this.db.signatureExists(signature)) {
        processed++;
        continue;
      }

      try {
        const activities = await this.processSignature(signature);
        indexed += activities;
        processed++;
      } catch (error) {
        console.error(`[Indexer] Error processing ${signature}:`, error);
        processed++;
      }
    }

    return { processed, indexed };
  }

  /**
   * Process a single signature
   */
  private async processSignature(signature: string): Promise<number> {
    try {
      // Fetch transaction
      const txResponse = await this.rpc
        .getTransaction(signature as unknown as Parameters<typeof this.rpc.getTransaction>[0], {
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        } as Parameters<typeof this.rpc.getTransaction>[1])
        .send();

      if (!txResponse) {
        return 0;
      }

      // Type assertion for the transaction response
      const tx = txResponse as unknown as {
        slot: number;
        blockTime: number | null;
        meta: { err: unknown; preTokenBalances?: unknown[]; postTokenBalances?: unknown[] } | null;
        transaction: {
          message: {
            accountKeys: Array<string | { pubkey: string }>;
            instructions: Array<{
              programIdIndex: number;
              accounts: number[];
              data: string;
            }>;
          };
          signatures: string[];
        };
      };

      // Quick check - does this tx even involve Token-2022?
      const accountKeys = tx.transaction.message.accountKeys.map((k) =>
        typeof k === 'string' ? k : k.pubkey
      );

      if (!mightContainCT(accountKeys)) {
        return 0;
      }

      // Parse for CT activities
      const activities = parseTransaction(tx as unknown as Parameters<typeof parseTransaction>[0], signature);

      // Store activities
      for (const activity of activities) {
        const id = this.db.insertActivity(activity);
        if (id) {
          this.db.incrementActivityCount();

          // Track token accounts
          if (activity.sourceTokenAccount && activity.sourceOwner && activity.mint) {
            this.db.upsertTokenAccount({
              address: activity.sourceTokenAccount,
              mint: activity.mint,
              owner: activity.sourceOwner,
              lastSeenSlot: activity.slot,
            });
          }
          if (activity.destTokenAccount && activity.destOwner && activity.mint) {
            this.db.upsertTokenAccount({
              address: activity.destTokenAccount,
              mint: activity.mint,
              owner: activity.destOwner,
              lastSeenSlot: activity.slot,
            });
          }

          // Track mints
          if (activity.mint) {
            this.db.upsertMint({
              address: activity.mint,
              decimals: 9, // Default, could be fetched
              name: null,
              symbol: null,
              lastSeenSlot: activity.slot,
            });
          }
        }
      }

      return activities.length;
    } catch (error) {
      // Don't throw for parse errors, just log
      if (error instanceof Error && error.message.includes('parse')) {
        console.warn(`[Indexer] Parse warning for ${signature}: ${error.message}`);
        return 0;
      }
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
