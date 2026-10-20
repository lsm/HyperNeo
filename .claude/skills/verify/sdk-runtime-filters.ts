import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { strictEqual, ok } from 'node:assert';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { SDK_MESSAGE_COLUMN_TYPES, deriveSdkMessageColumns } from '../../../packages/daemon/src/storage/sdk-message-columns.ts';
import { readSpaceStartReceipt } from '../../../packages/daemon/src/lib/drivers/space-adapter.ts';
import { readSessionInputEvidence } from '../../../packages/daemon/src/lib/drivers/space-input-evidence.ts';
import { readHyperneoInputs, readHyperneoLastResult, readHyperneoExchange } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';

const [, , mode, run, name = mode] = process.argv;
if (!run || !['seed', 'measure'].includes(mode) || process.env.NODE_ENV !== 'test')
  throw new Error('NODE_ENV=test bun sdk-runtime-filters.ts seed|measure <fresh-run-dir> [evidence-name]');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const sid = 'synthetic-runtime';
const core = new DatabaseCore(join(run, 'data/daemon.db'));
const lag = { startup: 0, queries: 0 };
let phase: keyof typeof lag = 'startup';
let last = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  lag[phase] = Math.max(lag[phase], now - last - 10);
  last = now;
}, 10);
try {
  const startedAt = performance.now();
  await core.initialize();
  const startupMs = performance.now() - startedAt;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const db = core.getDb();
  if (mode === 'seed') {
    clearInterval(heartbeat);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Runtime filter proof',?,datetime('now'),datetime('now'),'active','{\"model\":\"sonnet\"}','{}')").run(sid, run);
    const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES) as (keyof typeof SDK_MESSAGE_COLUMN_TYPES)[];
    const insert = db.prepare(`INSERT INTO sdk_messages (id,session_id,message_type,message_subtype,sdk_message,timestamp,send_status,sdk_uuid,consumed_seq,is_terminal,replacement_metadata_normalized,task_id,${names.join(',')}) VALUES (?,?,?,?,?,?,'consumed',?,?,?,1,?,${names.map(() => '?').join(',')})`);
    const hash = createHash('sha256');
    const put = (id: string, message: Record<string, unknown>, seq: number, taskId: string | null) => {
      const body = JSON.stringify(message);
      const derived = deriveSdkMessageColumns(message, taskId);
      insert.run(id, sid, message.type, message.type === 'result' ? 'success' : null, body, new Date(seq * 1000).toISOString(), id, seq, Number(message.type === 'result'), taskId, ...names.map((key) => derived[key]));
      hash.update(body);
    };
    const tool = 'full-tool-result-'.repeat(43_750);
    db.transaction(() => {
      for (let i = 0; i < 55_000; i++) {
        const heavy = i % 100 === 0;
        put(`m-${i}`, { type: 'user', uuid: `m-${i}`, inputKind: 'task', ...(heavy ? { isReplay: true } : {}), message: { role: 'user', content: heavy ? [{ type: 'tool_result', content: tool }] : `message ${i}` } }, i + 1, 'synthetic-task');
      }
      put('last-human', { type: 'user', uuid: 'last-human', inputKind: 'human', message: { role: 'user', content: 'Runtime filter proof' } }, 60_000, null);
      put('last-result', { type: 'result', uuid: 'last-result', result: 'runtime-filter-token', is_error: false }, 60_001, null);
    })();
    const result = { rows: 55_002, bodyHash: hash.digest('hex'), replacement_metadata_normalized: 1 };
    writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify(result));
    console.log(JSON.stringify(result));
  } else {
    const queries: { sql: string; durationMs: number; plan: unknown }[] = [];
    const observed = Object.assign(Object.create(db), { prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== 'get' && key !== 'all') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const startedAt = performance.now();
          const result = value.apply(target, args);
          const durationMs = performance.now() - startedAt;
          queries.push({ sql, durationMs, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) });
          return result;
        };
      } });
    } });
    const repo = new SDKMessageRepository(observed);
    const calls = {
      startReceipt: () => readSpaceStartReceipt(observed, 'synthetic-task'),
      evidence: () => readSessionInputEvidence(observed, sid, { executionId: sid, inputId: 'last-human' }),
      inputs: () => readHyperneoInputs(observed, sid),
      inputsSince: () => readHyperneoInputs(observed, sid, 59_999_000),
      lastResult: () => readHyperneoLastResult(observed, sid),
      exchange: () => readHyperneoExchange(observed, sid, 59_999_000),
      status: () => repo.getUserMessagesByStatus(sid, 'consumed', 20),
      human: () => repo.lastHumanPromptAt(sid),
      restart: () => repo.readRestartRecoveryEvidence(sid),
      task: () => repo.hasConsumedTaskInputForSession(sid, 'absent-task'),
      action: () => repo.hasUnresolvedHyperNeoAction(sid, 'absent-action'),
    };
    phase = 'queries';
    last = performance.now();
    const receipts: Record<string, unknown> = {};
    const methods: Record<string, number> = {};
    for (const [key, call] of Object.entries(calls)) {
      const startedAt = performance.now();
      receipts[key] = call();
      methods[key] = performance.now() - startedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    clearInterval(heartbeat);
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT sdk_message FROM sdk_messages WHERE session_id=? ORDER BY seq').iterate(sid) as Iterable<{ sdk_message: string }>) hash.update(row.sdk_message);
    const result = { lag, startupMs, methods, maxQueryMs: Math.max(...queries.map((query) => query.durationMs)), queries, receiptHash: createHash('sha256').update(JSON.stringify(receipts)).digest('hex'), bodyHash: hash.digest('hex'), receipts };
    writeFileSync(join(run, `evidence/${name}.json`), JSON.stringify(result, null, 2));
    strictEqual(result.bodyHash, JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8')).bodyHash);
    if (name !== 'before') {
      if (existsSync(join(run, 'evidence/before.json'))) {
        const before = JSON.parse(readFileSync(join(run, 'evidence/before.json'), 'utf8'));
        strictEqual(result.receiptHash, before.receiptHash);
        strictEqual(result.bodyHash, before.bodyHash);
      }
      ok(Math.max(lag.startup, lag.queries) < 1000, 'Event-loop lag exceeded 1 s');
      ok(result.maxQueryMs < 250, 'Query exceeded 250 ms');
    }
    console.log(JSON.stringify({ lag, startupMs, methods, maxQueryMs: result.maxQueryMs, receiptHash: result.receiptHash, bodyHash: result.bodyHash }));
  }
} finally {
  clearInterval(heartbeat);
  await core.close();
}
