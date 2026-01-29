import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { config } from 'dotenv';
import { CTDatabase } from './database.js';

config();

const dbPath = process.env['DATABASE_PATH'] || './data/ct-explorer.db';

// Ensure directory exists
const dbDir = dirname(dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
  console.log(`[Migrate] Created directory: ${dbDir}`);
}

console.log(`[Migrate] Initializing database at: ${dbPath}`);

const db = new CTDatabase({ path: dbPath });
db.migrate();

console.log('[Migrate] Migration complete!');
db.close();
