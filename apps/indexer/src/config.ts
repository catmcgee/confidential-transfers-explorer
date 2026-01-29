import { config } from 'dotenv';

config();

export interface IndexerConfig {
  rpcUrl: string;
  wsUrl: string;
  databasePath: string;
  batchSize: number;
  pollIntervalMs: number;
  backfillSignatures: number;
}

export function loadConfig(): IndexerConfig {
  const rpcUrl = process.env['SOLANA_RPC_URL'] || 'https://zk-edge.surfnet.dev:8899';

  // Infer WebSocket URL from HTTP URL
  let wsUrl = process.env['SOLANA_WS_URL'];
  if (!wsUrl) {
    wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  }

  return {
    rpcUrl,
    wsUrl,
    databasePath: process.env['DATABASE_PATH'] || './data/ct-explorer.db',
    batchSize: parseInt(process.env['INDEXER_BATCH_SIZE'] || '100', 10),
    pollIntervalMs: parseInt(process.env['INDEXER_POLL_INTERVAL_MS'] || '5000', 10),
    backfillSignatures: parseInt(process.env['BACKFILL_SIGNATURES'] || '1000', 10),
  };
}
