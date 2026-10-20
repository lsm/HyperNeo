import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const LIVE_STATS: [string, string][] = [
  ['idx_sdk_messages_bg_task_time', '99652 243 49 27 1'],
  ['idx_sdk_messages_bg_tool_time', '99652 243 49 23 1'],
  ['idx_sdk_messages_consumed_boundary', '4221 20 1 1'],
  ['idx_sdk_messages_consumed_input_time', '3836 26 26 26 1'],
  ['idx_sdk_messages_deferred_uuid', '0 0'],
  ['idx_sdk_messages_exchange_time', '7849 26 1 1'],
  ['idx_sdk_messages_first_block_time', '99652 243 97 1 1 1 1 1'],
  ['idx_sdk_messages_input_kind_time', '99652 243 81 61 1'],
  ['idx_sdk_messages_open_action', '0 0 0 0'],
  ['idx_sdk_messages_parent_tool_use_id', '99652 243 122'],
  ['idx_sdk_messages_renderable_terminal', '99652 243 162 122 1 1'],
  ['idx_sdk_messages_restart_prompt', '4236 20 20 20 20 20 1 1 1'],
  ['idx_sdk_messages_result_boundary', '3614 19 1'],
  ['idx_sdk_messages_result_time', '3613 19 19 19 1'],
  ['idx_sdk_messages_send_status_timestamp', '99652 243 243 1'],
  ['idx_sdk_messages_session_subtype_parent', '99652 243 49 41'],
  ['idx_sdk_messages_session_subtype_time', '99652 243 49 41 1'],
  ['idx_sdk_messages_session_timestamp_id', '99652 243 1 1'],
  ['idx_sdk_messages_session_uuid', '99652 243 1'],
  ['idx_sdk_messages_session_visible', '99652 243 122 1 1 1 1 1'],
  ['idx_sdk_messages_session_window', '99652 243 122 1 1 1 1 1 1 1 1'],
  ['idx_sdk_messages_start_receipt', '4295 485 485 485 1 1 1 1'],
  ['idx_sdk_messages_status_projection', '99652 243 243 81 81 1 1 1'],
  ['idx_sdk_messages_task_assistant', '34816 485 1'],
  ['idx_sdk_messages_task_id', '99652 485 1'],
  ['idx_sdk_messages_task_input', '3863 18 18 15 1 1'],
  ['idx_sdk_messages_task_session_turn', '99652 485 243 243'],
  ['idx_sdk_messages_task_turn', '99652 485 485'],
  ['idx_sdk_messages_unnormalized_replacements', '0 0'],
  ['sqlite_autoindex_sdk_messages_1', '99652 1'],
];
const ROWS = Number(process.argv[2] ?? 45_000);
const TOOLS = Number(process.argv[3] ?? 10);
const dir = mkdtempSync(join(tmpdir(), 'subagent-lookup-'));
const path = join(dir, 'd.db');
const seed = new Database(path);
runMigrations(seed, () => {});
createTables(seed);
seed.exec('PRAGMA foreign_keys = OFF');
const insert = seed.prepare(
  `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, parent_tool_use_id)
   VALUES (?, 's1', 'assistant', ?, ?, ?)`
);
const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } });
seed.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(`m${i}`, filler, at(i), null);
  for (let t = 0; t < TOOLS; t++) {
    insert.run(`tool${t}`, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu${t}`, name: 'Task', input: {} }] } }), at(ROWS + t * 4), null);
    for (let i = 0; i < 3; i++) insert.run(`child${t}-${i}`, filler, at(ROWS + t * 4 + 1 + i), `tu${t}`);
  }
})();
seed.exec('ANALYZE');
seed.exec("DELETE FROM sqlite_stat1 WHERE tbl = 'sdk_messages'");
const live = seed.prepare(
  `INSERT INTO sqlite_stat1 (tbl, idx, stat) SELECT 'sdk_messages', ?, ?
    WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)`
);
for (const [idx, stat] of LIVE_STATS) live.run(idx, stat, idx);
seed.close();

const db = new Database(path);
let plan = '';
let lookupMs = 0;
const prepare = db.prepare.bind(db);
const repo = new SDKMessageRepository(
  Object.assign(Object.create(db), {
    prepare: (sql: string) => {
      const stmt = prepare(sql);
      if (!sql.includes('parent_tool_use_id IN')) return stmt;
      plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all('s1', ...Array.from({ length: (sql.match(/\?/g)?.length ?? 2) - 1 }, (_, i) => `tu${i}`)) as { detail: string }[])
        .map((row) => row.detail)
        .filter((detail) => detail.includes('sdk_messages'))
        .join(' | ');
      return {
        all: (...args: unknown[]) => {
          const started = performance.now();
          const rows = stmt.all(...(args as []));
          lookupMs = performance.now() - started;
          return rows;
        },
      };
    },
  })
);
const runs: string[] = [];
for (let i = 0; i < 3; i++) {
  const page = repo.getSDKMessages('s1', 50);
  runs.push(`${lookupMs.toFixed(1)}ms/${page.messages.length}msgs`);
}
console.log(`rows=${ROWS} tools=${TOOLS} subagent lookup per page load: ${runs.join(' ')}\nplan: ${plan}`);
db.close();
rmSync(dir, { recursive: true, force: true });
