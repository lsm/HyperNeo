import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [runText, systemText = '17000', otherText = '120000'] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
mkdirSync(run, { recursive: true });
const dbPath = join(run, 'notices.db');
assert(!existsSync(dbPath), 'requires a fresh synthetic database');
const db = new Database(dbPath);
runMigrations(db, () => {});
createTables(db);
db.exec("PRAGMA foreign_keys = OFF; INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata) VALUES ('neo:root', 'Neo', '/tmp', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 'active', '{}', '{}')");
const insert = db.prepare(
  `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const pad = 'x'.repeat(1500);
let n = 0;
const at = (i: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + i * 1000).toISOString();
db.transaction(() => {
  for (let i = 0; i < Number(otherText); i++, n++)
    insert.run(`o${i}`, i % 4 ? `s${i % 50}` : 'neo:root', i % 3 ? 'assistant' : 'user', null, JSON.stringify({ type: 'assistant', pad }), at(n));
  for (let i = 0; i < Number(systemText); i++, n++)
    insert.run(`y${i}`, 'neo:root', 'system', i % 2 ? 'status' : 'session_state_changed', JSON.stringify({ type: 'system', pad }), at(n));
  for (let i = 0; i < 82; i++, n++)
    insert.run(`g${i}`, 'neo:root', 'system', 'session_notices', JSON.stringify({ type: 'system', subtype: 'session_notices', uuid: `g${i}` }), at(n));
})();
db.close();
const select = (column: string) =>
  `WITH body_selection AS MATERIALIZED (SELECT rowid AS body_seq, timestamp FROM sdk_messages
     ${column === 'message_subtype' ? '' : 'INDEXED BY idx_sdk_messages_session_subtype_parent'}
     WHERE session_id = 'neo:root' AND message_type = 'system' AND ${column} = 'session_notices'
     ORDER BY timestamp DESC, rowid DESC LIMIT 10)
   SELECT count(*) FROM body_selection JOIN sdk_messages original ON original.rowid = body_selection.body_seq
   LEFT JOIN sdk_message_bodies body ON body.seq = body_selection.body_seq;`;
const measure = (column: string) => {
  const result = spawnSync('sqlite3', ['-readonly', dbPath, '-cmd', '.stats on', select(column)], {
    encoding: 'utf8',
  });
  const out = `${result.stdout}${result.stderr}`;
  return {
    filter: column,
    pageCacheMisses: Number(out.match(/Page cache misses:\s+(\d+)/)?.[1]),
  };
};
const report = { rows: n, before: measure('message_subtype'), after: measure('message_subtype_norm') };
writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
