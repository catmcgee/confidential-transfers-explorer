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
}

console.log(`[Seed] Seeding database at: ${dbPath}`);

const db = new CTDatabase({ path: dbPath });
db.migrate();

// Add some sample data for development/testing
const sampleActivities = [
  {
    signature: 'sample1111111111111111111111111111111111111111111111111111111111111111111',
    slot: 1000000,
    blockTime: Math.floor(Date.now() / 1000) - 3600,
    instructionType: 'Transfer' as const,
    mint: 'SampleMint11111111111111111111111111111111',
    sourceOwner: 'SampleOwner1111111111111111111111111111111',
    destOwner: 'SampleOwner2222222222222222222222222222222',
    sourceTokenAccount: 'SampleToken111111111111111111111111111111',
    destTokenAccount: 'SampleToken222222222222222222222222222222',
    ciphertextLo: 'c2FtcGxlY2lwaGVydGV4dGxvbG9sb2xvbG8=',
    ciphertextHi: 'c2FtcGxlY2lwaGVydGV4dGhpaGloaWhpaGk=',
    publicAmount: null,
    instructionData: 'c2FtcGxlaW5zdHJ1Y3Rpb25kYXRh',
  },
  {
    signature: 'sample2222222222222222222222222222222222222222222222222222222222222222222',
    slot: 1000001,
    blockTime: Math.floor(Date.now() / 1000) - 3000,
    instructionType: 'Deposit' as const,
    mint: 'SampleMint11111111111111111111111111111111',
    sourceOwner: 'SampleOwner1111111111111111111111111111111',
    destOwner: 'SampleOwner1111111111111111111111111111111',
    sourceTokenAccount: null,
    destTokenAccount: 'SampleToken111111111111111111111111111111',
    ciphertextLo: null,
    ciphertextHi: null,
    publicAmount: '1000000000',
    instructionData: 'c2FtcGxlZGVwb3NpdGRhdGE=',
  },
  {
    signature: 'sample3333333333333333333333333333333333333333333333333333333333333333333',
    slot: 1000002,
    blockTime: Math.floor(Date.now() / 1000) - 2400,
    instructionType: 'ApplyPendingBalance' as const,
    mint: 'SampleMint11111111111111111111111111111111',
    sourceOwner: 'SampleOwner2222222222222222222222222222222',
    destOwner: 'SampleOwner2222222222222222222222222222222',
    sourceTokenAccount: 'SampleToken222222222222222222222222222222',
    destTokenAccount: 'SampleToken222222222222222222222222222222',
    ciphertextLo: null,
    ciphertextHi: null,
    publicAmount: null,
    instructionData: 'c2FtcGxlYXBwbHlkYXRh',
  },
  {
    signature: 'sample4444444444444444444444444444444444444444444444444444444444444444444',
    slot: 1000003,
    blockTime: Math.floor(Date.now() / 1000) - 1800,
    instructionType: 'Withdraw' as const,
    mint: 'SampleMint11111111111111111111111111111111',
    sourceOwner: 'SampleOwner2222222222222222222222222222222',
    destOwner: 'SampleOwner2222222222222222222222222222222',
    sourceTokenAccount: 'SampleToken222222222222222222222222222222',
    destTokenAccount: null,
    ciphertextLo: null,
    ciphertextHi: null,
    publicAmount: '500000000',
    instructionData: 'c2FtcGxld2l0aGRyYXdkYXRh',
  },
];

console.log('[Seed] Inserting sample activities...');
for (const activity of sampleActivities) {
  const id = db.insertActivity(activity);
  if (id) {
    console.log(`[Seed] Inserted activity ${id}: ${activity.instructionType}`);
    db.incrementActivityCount();
  }
}

// Add sample mints
db.upsertMint({
  address: 'SampleMint11111111111111111111111111111111',
  decimals: 9,
  name: 'Sample Token',
  symbol: 'SMPL',
  lastSeenSlot: 1000003,
});

// Add sample token accounts
db.upsertTokenAccount({
  address: 'SampleToken111111111111111111111111111111',
  mint: 'SampleMint11111111111111111111111111111111',
  owner: 'SampleOwner1111111111111111111111111111111',
  lastSeenSlot: 1000001,
});

db.upsertTokenAccount({
  address: 'SampleToken222222222222222222222222222222',
  mint: 'SampleMint11111111111111111111111111111111',
  owner: 'SampleOwner2222222222222222222222222222222',
  lastSeenSlot: 1000003,
});

console.log('[Seed] Done!');
console.log(`[Seed] Total activities: ${db.getTotalActivityCount()}`);
db.close();
