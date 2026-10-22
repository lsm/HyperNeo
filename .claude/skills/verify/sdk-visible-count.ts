import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[key], key);
for (const dir of ['home', 'data', 'evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const original = SDKMessageRepository.prototype.recomputeVisibleMessageCount;
const calls: number[] = [];
const evidence: Record<string, unknown> = { calls };
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'home'), title: 'Large synthetic history', config: { queryMode: 'manual' } });
  const db = app.db.getDatabase();
  db.exec('PRAGMA synchronous=NORMAL');
  const count = Number(process.env.VERIFY_COUNT_ROWS ?? 360000);
  const insert = db.prepare(`INSERT INTO sdk_messages
    (id,session_id,message_type,message_subtype,sdk_message,timestamp,send_status,sdk_uuid,parent_tool_use_id,replacement_metadata_normalized)
    VALUES (?,?,?,NULL,?,'2026-10-21T00:00:00.000Z',?,?,NULL,1)`);
  const body = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic retained history. '.repeat(180) }] }, parent_tool_use_id: null });
  for (let offset = 0; offset < count; offset += 1000) {
    db.transaction(() => {
      for (let i = offset; i < Math.min(offset + 1000, count); i++) insert.run(`history-${i}`, sessionId, 'assistant', body, null, `history-${i}`);
    })();
    await Bun.sleep(0);
  }
  const uuid = crypto.randomUUID();
  const retryBody = JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: 'Synthetic retry' }, parent_tool_use_id: null });
  insert.run('retry-row', sessionId, 'user', retryBody, 'failed', uuid);
  db.prepare('UPDATE sessions SET visible_message_count = ? WHERE id = ?').run(count + 1, sessionId);
  const guard = app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId, messageUuid: 'synthetic-active', released: true }, priority: 10, createdAt: 0 });
  db.prepare("UPDATE job_queue SET status = 'processing', started_at = ?, heartbeat_at = ? WHERE id = ?").run(Date.now(), Date.now(), guard.id);
  SDKMessageRepository.prototype.recomputeVisibleMessageCount = function (id) {
    const started = performance.now();
    try { return original.call(this, id); }
    finally { calls.push(performance.now() - started); }
  };
  let lagMs = 0;
  let previous = performance.now();
  heartbeat = setInterval(() => { const now = performance.now(); lagMs = Math.max(lagMs, now - previous - 10); previous = now; }, 10);
  await Bun.sleep(20);
  const started = performance.now();
  const receipt = await hub.request<{ retried: boolean }>('session.messages.retry', { sessionId, messageDbId: 'retry-row' });
  const rpcMs = performance.now() - started;
  await Bun.sleep(20);
  const row = db.prepare('SELECT visible_message_count AS count FROM sessions WHERE id = ?').get(sessionId) as { count: number };
  evidence.result = { receipt, rows: count + 1, visibleCount: row.count, rpcMs, lagMs, runtime: Bun.version };
  assert.equal(receipt.retried, true);
  assert.equal(row.count, count);
  const retained = db.prepare('SELECT COUNT(*) AS count, SUM(length(sdk_message)) AS bodyBytes FROM sdk_messages WHERE session_id = ?').get(sessionId);
  evidence.retained = retained;
  assert.equal((retained as { count: number }).count, count + 1);
  assert.equal((retained as { bodyBytes: number }).bodyBytes, count * body.length + retryBody.length);
  console.log(JSON.stringify(evidence, null, 2));
  assert(Math.max(0, ...calls) < 250, 'Visible count exceeded 250ms');
  assert(lagMs < 1000, 'Event loop blocked >=1s');
  assert(rpcMs < 250, 'Retry RPC exceeded 250ms');
} finally {
  if (heartbeat) clearInterval(heartbeat);
  SDKMessageRepository.prototype.recomputeVisibleMessageCount = original;
  writeFileSync(join(run, 'evidence/visible-count.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
}
