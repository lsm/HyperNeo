import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { strictEqual, ok } from 'node:assert';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { SDKMessageRepository, computeIsRenderable, computeIsTerminal } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { SDK_MESSAGE_COLUMN_TYPES, deriveSdkMessageColumns } from '../../../packages/daemon/src/storage/sdk-message-columns.ts';
import { NAMED_QUERY_REGISTRY } from '../../../packages/daemon/src/lib/live-query/registry.ts';
import { BACKGROUND_TASK_METADATA_SQL } from '../../../packages/daemon/src/lib/live-query/queries/messages.ts';
import { ensureTaskMessageRows } from '../../../packages/daemon/src/storage/schema/task-message-rows.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const [, , mode, run, name = mode] = process.argv;
if (!run || !['seed', 'measure'].includes(mode) || process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test bun sdk-live-query-filters.ts seed|measure <fresh-run-dir> [name]');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const core = new DatabaseCore(join(run, 'data/daemon.db'));
let maxLagMs = 0;
let last = performance.now();
const heartbeat = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
try {
  await core.initialize();
  const db = core.getDb();
  const sid = 'synthetic-live';
  if (mode === 'seed') {
    clearInterval(heartbeat);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Live-query proof',?,datetime('now'),datetime('now'),'active','{}','{}')").run(sid, run);
    db.prepare("INSERT INTO spaces(id,slug,name,workspace_path,status,created_at,updated_at) VALUES ('proof-space','proof-space','Proof',?,'archived',1,1)").run(run);
    db.exec("INSERT INTO space_tasks(id,space_id,task_number,title,status,created_at,updated_at) VALUES ('proof-task','proof-space',1,'Task proof','in_progress',1,1)");
    const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
    const insert = db.prepare(`INSERT INTO sdk_messages(id,session_id,message_type,message_subtype,sdk_uuid,sdk_message,timestamp,parent_tool_use_id,task_id,is_renderable,is_terminal,conversation_turn_index,consumed_seq,replacement_metadata_normalized,${names.join(',')}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,${names.map(() => '?').join(',')})`);
    const hash = createHash('sha256');
    const put = (id: string, body: Record<string, unknown>, at: number, subtype: string | null = null, parent: string | null = null, task: string | null = null) => {
      const message = { uuid: id, ...body };
      const raw = JSON.stringify(message);
      const columns = deriveSdkMessageColumns(message, task);
      insert.run(id, sid, message.type, subtype, id, raw, new Date(at * 1000).toISOString(), parent, task, Number(computeIsRenderable(message as SDKMessage)), Number(computeIsTerminal(message as SDKMessage)), task ? 1 : null, at, ...names.map((key) => columns[key]));
      hash.update(raw);
    };
    const tool = 'full-tool-result-'.repeat(43_750);
    db.transaction(() => {
      for (let i = 0; i < 55_000; i++) {
        if (i % 100 === 0) put(`m-${i}`, { type: 'user', isReplay: true, message: { content: [{ type: 'tool_result', content: tool }] } }, i + 1);
        else if (i % 5 === 0) put(`m-${i}`, { type: 'system', task_id: `task-${i % 200}`, tool_use_id: `tool-${i % 100}`, summary: `progress ${i}` }, i + 1, 'task_progress');
        else put(`m-${i}`, { type: 'assistant', message: { content: [{ type: 'text', text: `message ${i}` }] } }, i + 1);
      }
      put('start', { type: 'system', task_id: 'live-task' }, 60_000, 'task_started');
      put('progress-old', { type: 'system', task_id: 'live-task', tool_use_id: 'live-tool', summary: 'old' }, 60_001, 'task_progress');
      put('progress-new', { type: 'system', task_id: 'live-task', tool_use_id: 'live-tool', summary: 'new' }, 60_002, 'task_progress');
      put('info-hidden', { type: 'system', level: 'info', content: 'hidden' }, 60_003, 'informational');
      put('parent', { type: 'assistant', message: { content: [{ type: 'text', text: 'Live-query proof token' }, { type: 'tool_use', id: 'proof-tool', name: 'Bash', input: {} }] } }, 60_004);
      put('child', { type: 'assistant', message: { content: [{ type: 'text', text: 'Child proof token' }] } }, 60_005, null, 'proof-tool');
      put('stranger', { type: 'assistant', message: { content: [] } }, 60_006, null, 'other-tool');
      put('task-user', { type: 'user', message: { content: 'Task proof token' } }, 60_007, null, null, 'proof-task');
      put('task-tool-only', { type: 'user', message: { content: [{ type: 'tool_result', content: 'Full task result' }] } }, 60_008, null, null, 'proof-task');
      put('task-assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'Active task token' }] } }, 60_009, null, null, 'proof-task');
      for (const [index, subtype] of ['hook_started', 'hook_progress', 'hook_response'].entries())
        put(`task-hook-${index}`, { type: 'system', subtype, hook_id: 'hook', hook_name: 'Read', hook_event: 'PreToolUse', outcome: 'success' }, 60_010 + index, subtype, null, 'proof-task');
      put('task-info-hidden', { type: 'system', subtype: 'informational', level: 'info' }, 60_013, 'informational', null, 'proof-task');
    })();
    const result = { rows: 55_014, bodyHash: hash.digest('hex'), replacement_metadata_normalized: 1 };
    writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify(result));
    console.log(JSON.stringify(result));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startupLagMs = maxLagMs;
    maxLagMs = 0; last = performance.now();
    const queries: { sql: string; durationMs: number; plan: unknown }[] = [];
    const observed = Object.assign(Object.create(db), { prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== 'get' && key !== 'all') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const started = performance.now(); const result = value.apply(target, args);
          queries.push({ sql, durationMs: performance.now() - started, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) }); return result;
        };
      } });
    } });
    const repo = new SDKMessageRepository(observed);
    ensureTaskMessageRows(db, 'proof-task');
    const feed = (name: string) => {
      const query = NAMED_QUERY_REGISTRY.get(name)!;
      let rows = observed.prepare(query.sql).all(sid, 200) as Record<string, unknown>[];
      if (query.expandRows) rows = query.expandRows(rows, [sid, 200], observed);
      return rows.map(query.mapRow!);
    };
    const receipts: Record<string, unknown> = {};
    const methods: Record<string, number> = {};
    const taskFeed = (name: string) => { const query = NAMED_QUERY_REGISTRY.get(name)!; return (observed.prepare(query.sql).all('proof-task') as Record<string, unknown>[]).map(query.mapRow!); };
    for (const [key, call] of Object.entries({ repository: () => repo.getSDKMessages(sid, 200), repositoryBackground: () => repo.getBackgroundTaskMessages(sid), sidecar: () => observed.prepare(BACKGROUND_TASK_METADATA_SQL).all(...Array(7).fill(sid)), full: () => feed('messages.bySession'), compact: () => feed('messages.bySession.compact'), task: () => taskFeed('spaceTaskMessages.byTask'), activeTurn: () => taskFeed('spaceTaskActiveTurn.byTask') })) {
      const started = performance.now(); receipts[key] = call(); methods[key] = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    clearInterval(heartbeat);
    const bodyHash = createHash('sha256');
    for (const row of db.prepare('SELECT sdk_message FROM sdk_messages ORDER BY seq').iterate() as Iterable<{ sdk_message: string }>) bodyHash.update(row.sdk_message);
    const result = { startupLagMs, maxLagMs, maxQueryMs: Math.max(...queries.map((q) => q.durationMs)), methods, queries, bodyHash: bodyHash.digest('hex'), receiptHash: createHash('sha256').update(JSON.stringify(receipts)).digest('hex'), receipts };
    writeFileSync(join(run, `evidence/${name}.json`), JSON.stringify(result, null, 2));
    strictEqual(result.bodyHash, JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8')).bodyHash);
    if (name !== 'before' && existsSync(join(run, 'evidence/before.json'))) {
      const before = JSON.parse(readFileSync(join(run, 'evidence/before.json'), 'utf8'));
      strictEqual(result.receiptHash, before.receiptHash);
      ok(Math.max(startupLagMs, maxLagMs) < 1000, 'Event-loop lag exceeded 1 s');
      ok(result.maxQueryMs < 250, 'Query exceeded 250 ms');
    }
    console.log(JSON.stringify({ startupLagMs, maxLagMs, maxQueryMs: result.maxQueryMs, methods, bodyHash: result.bodyHash, receiptHash: result.receiptHash }));
  }
} finally { clearInterval(heartbeat); await core.close(); }
