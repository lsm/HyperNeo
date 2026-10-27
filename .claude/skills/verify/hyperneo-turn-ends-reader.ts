import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const [mode, run] = process.argv.slice(2);
assert(['baseline', 'verify'].includes(mode));
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
const logs: Record<string, unknown>[] = [];
const unsubscribe = subscribeToStructuredLogs(event => {
  if (event.module === 'hyperneo:daemon:sqlite.query') logs.push(event.metadata);
});
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), sqlQueryObservability: { slowThresholdMs: 0, summaryIntervalMs: 300000, maxQueryGroups: 500, summaryQueryLimit: 10 }, port: 0, disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
assert.notEqual(app.server.port, 8399);
let socket: WebSocket | undefined;
const evidence: Record<string, unknown> = { mode };
const raw = app.db.getDatabase();
const prepare = raw.prepare.bind(raw);
let mainReads = 0;
try {
  socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(new Error('RPC socket failed')); });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.onmessage = ({ data }) => { const reply = JSON.parse(String(data)), entry = pending.get(reply.requestId ?? reply.id); if (entry) { pending.delete(reply.requestId ?? reply.id); reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.data); } };
  const rpc = (method: string, data: unknown = {}) => new Promise<unknown>((resolve, reject) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const { sessionId } = await rpc('session.create', { workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' } }) as { sessionId: string };
  const count = 160, text = 'Complete assistant report 🔬\n'.repeat(2048);
  const insert = prepare(`INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,is_terminal) VALUES (?,?,?,?,?,?,'consumed',?)`);
  raw.transaction(() => {
    for (let n = 0; n < count; n++) {
      for (const [offset, type, content] of [[1, 'user', 'Synthetic input'], [2, 'assistant', text + n], [3, 'result', n % 2 ? '' : `Explicit result ${n}`]] as const) {
        const id = `fixture-${n}-${type}`, timestamp = new Date((n * 10 + offset) * 1000).toISOString();
        const body = type === 'result' ? { type, subtype: 'success', result: content, is_error: false } : { type, message: { role: type, content: [{ type: 'text', text: content }] } };
        insert.run(id, sessionId, id, type, JSON.stringify(body), timestamp, type === 'result' ? 1 : 0);
      }
    }
  })();
  const digest = () => { const hash = createHash('sha256'); for (const row of prepare('SELECT COALESCE(b.sdk_message,m.sdk_message) AS sdk_message FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq').iterate() as Iterable<{ sdk_message: string }>) hash.update(row.sdk_message); return hash.digest('hex'); };
  const before = digest();
  raw.prepare = ((sql: string) => { if (/SELECT CAST\(m.rowid AS TEXT\) AS id, m.timestamp/i.test(sql)) { mainReads++; if (mode === 'verify') throw new Error('Turn-end SQL forbidden on daemon main connection'); } return prepare(sql); }) as typeof raw.prepare;
  const health: number[] = [];
  let active = true;
  const probe = (async () => { while (active) { const at = performance.now(); assert.equal((await rpc('system.health') as { status: string }).status, 'ok'); health.push(performance.now() - at); await new Promise(resolve => setTimeout(resolve, 5)); } })();
  const started = performance.now();
  let result: { ok: boolean; value: { turnEnds: { at: number; startedAt: number; message: string }[] } };
  try { result = await rpc('operation.invoke', { name: 'work.status', input: { ref: { adapter: 'hyperneo', id: sessionId }, since: 0 } }) as typeof result; }
  finally { active = false; await probe; evidence.rpcMs = performance.now() - started; evidence.healthMs = health; evidence.mainReads = mainReads; }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.turnEnds.length, count);
  for (let n = 0; n < count; n++) assert.deepEqual({ at: result.value.turnEnds[n].at, startedAt: result.value.turnEnds[n].startedAt, message: result.value.turnEnds[n].message }, { at: (n * 10 + 3) * 1000, startedAt: (n * 10 + 1) * 1000, message: n % 2 ? text + n : `Explicit result ${n}` });
  assert.equal(digest(), before);
  evidence.bodySha256 = before;
  evidence.turns = count;
  evidence.workerQueries = logs.filter(m => m.workerKind === 'sdk-status' && m.workerOperation === 'hyperneo-turn-ends' && m.event === 'slow' && m.operation === 'all');
  assert.equal(mainReads, 0, 'Turn-end SQL blocked the daemon main connection');
  assert((evidence.workerQueries as unknown[]).length > 0, 'No worker query evidence');
  evidence.passed = true;
} finally {
  raw.prepare = prepare;
  socket?.close();
  await app.cleanup();
  unsubscribe();
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
