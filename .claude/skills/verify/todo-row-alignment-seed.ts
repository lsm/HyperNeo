import './neo-todo-collapse-seed.ts';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const db = new Database(join(run, 'data/daemon.db'));
try {
  const sessions = new NeoTodoSessionRepository(db);
  const ref = { adapter: 'codex-desktop', id: 'synthetic-alignment-worker' };
  sessions.create('collapse-card-1', { verb: 'send', ref });
  sessions.recordRef('collapse-card-1', ref, Date.now(), 'codex://threads/synthetic-alignment-worker');
} finally {
  db.close();
}
