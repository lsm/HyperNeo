import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/index.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';

const dir = mkdtempSync(join(tmpdir(), 'hn-session-writer-'));
const db = new Database(join(dir, 'daemon.db'), { messageSearchIndexFlushIntervalMs: 0 });
const reactive = createReactiveDatabase(db);
await db.initialize(reactive);
const now = new Date().toISOString();
await db.createSession({
  id: 'writer-probe',
  title: 'Before',
  workspacePath: dir,
  createdAt: now,
  lastActiveAt: now,
  status: 'active',
  config: { model: 'fictional-model' },
  metadata: {
    messageCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    toolCallCount: 0,
  },
});

const changes: unknown[] = [];
reactive.on('change:sessions', (event) => changes.push(event.scope));
const main = db.getDatabase();
main.exec('BEGIN IMMEDIATE');
let landed = false;
const write = db.updateSession('writer-probe', { title: 'After' }).then(() => (landed = true));
await new Promise((resolve) => setTimeout(resolve, 300));
const blockedWhileMainHeldLock = !landed;
main.exec('COMMIT');
await write;

const checks = {
  blockedWhileMainHeldLock,
  landedAfterCommit: landed,
  readBack: db.getSession('writer-probe')?.title,
  changeReplayed: changes.length === 1,
};
console.log(JSON.stringify(checks, null, 1));
await db.close();
rmSync(dir, { recursive: true, force: true });
const pass =
  checks.blockedWhileMainHeldLock &&
  checks.landedAfterCommit &&
  checks.readBack === 'After' &&
  checks.changeReplayed;
process.exit(pass ? 0 : 1);
