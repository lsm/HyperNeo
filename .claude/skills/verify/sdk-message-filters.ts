import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { SDK_MESSAGE_COLUMN_TYPES, deriveSdkMessageColumns } from '../../../packages/daemon/src/storage/sdk-message-columns.ts';

const [, , mode, run, name = mode] = process.argv;
if (!run || !['seed', 'measure'].includes(mode) || process.env.NODE_ENV !== 'test')
  throw new Error('NODE_ENV=test bun sdk-message-filters.ts seed|measure <fresh-run-dir> [evidence-name]');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'data'), { recursive: true });
const core = new DatabaseCore(join(run, 'data/daemon.db'));
let phase = 'startup';
let last = performance.now();
const lag = { startup: 0, queries: 0 };
const heartbeat = setInterval(() => {
  const now = performance.now();
  lag[phase] = Math.max(lag[phase], now - last - 10);
  last = now;
}, 10);
try {
  await core.initialize();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const db = core.getDb();
  if (mode === 'seed') {
    clearInterval(heartbeat);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-filters','Synthetic filters',?,datetime('now'),datetime('now'),'active','{\"model\":\"sonnet\"}','{}')").run(run);
    const names = Object.keys(SDK_MESSAGE_COLUMN_TYPES);
    const insert = db.prepare(`INSERT INTO sdk_messages (id,session_id,message_type,sdk_message,timestamp,send_status,sdk_uuid,consumed_seq,replacement_metadata_normalized,task_id,${names.join(',')}) VALUES (?,'synthetic-filters','user',?,?,?, ?,?,1,'synthetic-task',${names.map(() => '?').join(',')})`);
    const tool = 'tool-result-kept-'.repeat(43_750);
    const hash = createHash('sha256');
    db.transaction(() => {
      for (let i = 0; i < 55_000; i++) {
        const heavy = i % 100 === 0;
        const message = { type: 'user', uuid: `m-${i}`, inputKind: 'task', ...(heavy ? { isReplay: true } : {}), message: { role: 'user', content: heavy ? [{ type: 'tool_result', content: tool }] : `message ${i}` } };
        const body = JSON.stringify(message);
        const derived = deriveSdkMessageColumns(message, 'synthetic-task');
        insert.run(`m-${i}`, body, new Date(i * 1000).toISOString(), i >= 54_990 ? 'deferred' : 'consumed', `m-${i}`, i < 54_990 ? i + 1 : null, ...names.map((key) => derived[key]));
        hash.update(body);
      }
    })();
    const result = { rows: 55_000, sha256: hash.digest('hex'), replacement_metadata_normalized: 1 };
    writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify(result));
    console.log(JSON.stringify(result));
  } else {
    const sqlTimes: { sql: string; durationMs: number }[] = [];
    const observed = Object.assign(Object.create(db), { prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== 'get' && key !== 'all') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const startedAt = performance.now();
          try { return value.apply(target, args); }
          finally { sqlTimes.push({ sql, durationMs: performance.now() - startedAt }); }
        };
      } });
    } });
    const repo = new SDKMessageRepository(observed);
    const calls = {
      status: () => repo.getUserMessagesByStatus('synthetic-filters', 'consumed', 20),
      ids: () => repo.getUserMessageIdsByStatus('synthetic-filters', 'deferred'),
      queued: () => repo.listQueuedInputs('synthetic-filters', 'human'),
      consumed: () => repo.lastConsumedInputSeq('synthetic-filters'),
      human: () => repo.lastHumanPromptAt('synthetic-filters'),
      restart: () => repo.readRestartRecoveryEvidence('synthetic-filters'),
      task: () => repo.hasConsumedTaskInputForSession('synthetic-filters', 'absent-task'),
      action: () => repo.hasUnresolvedHyperNeoAction('synthetic-filters', 'absent-action'),
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
    for (const row of db.prepare("SELECT sdk_message FROM sdk_messages WHERE session_id='synthetic-filters' ORDER BY seq").iterate() as Iterable<{ sdk_message: string }>) hash.update(row.sdk_message);
    const result = { lag, methods, maxQueryMs: Math.max(...sqlTimes.map((query) => query.durationMs)), sqlTimes, receiptHash: createHash('sha256').update(JSON.stringify(receipts)).digest('hex'), bodyHash: hash.digest('hex'), receipts };
    writeFileSync(join(run, `evidence/${name}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ lag, methods, maxQueryMs: result.maxQueryMs, receiptHash: result.receiptHash, bodyHash: result.bodyHash }));
  }
} finally {
  clearInterval(heartbeat);
  await core.close();
}
