import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { loadConfig } from './config.js';
import { CTIndexer } from './indexer.js';
import { getDatabase } from './db/database.js';
import { startApiServer } from './server.js';

async function main() {
  console.log('='.repeat(50));
  console.log('CT Explorer Indexer');
  console.log('='.repeat(50));

  const config = loadConfig();

  // Ensure database directory exists
  const dbDir = dirname(config.databasePath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    console.log(`[Main] Created data directory: ${dbDir}`);
  }

  // Initialize database
  const db = getDatabase({ path: config.databasePath });
  db.migrate();

  console.log('[Main] Configuration:');
  console.log(`  RPC URL: ${config.rpcUrl}`);
  console.log(`  WS URL: ${config.wsUrl}`);
  console.log(`  Database: ${config.databasePath}`);
  console.log(`  Batch size: ${config.batchSize}`);
  console.log(`  Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`  Backfill count: ${config.backfillSignatures}`);

  // Start API server so the web service can query indexed data
  const apiPort = parseInt(process.env['API_PORT'] || '3001', 10);
  startApiServer(db, apiPort);

  // Create and start indexer
  const indexer = new CTIndexer(config);

  // Handle shutdown
  const shutdown = () => {
    console.log('\n[Main] Shutting down...');
    indexer.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start indexing
  try {
    await indexer.start();
  } catch (error) {
    console.error('[Main] Fatal error:', error);
    db.close();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
