import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { neoFolder } from '../../../packages/daemon/src/lib/neo/folder.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { WorkTurnRepository } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });

const root = 'neo:10000000-0000-4000-8000-000000009730';
const worker = '10000000-0000-4000-8000-000000009731';
const ref = { adapter: 'hyperneo', id: worker };
const at = Date.now() - 60_000;
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const evidence: Record<string, unknown> = { daemonPort: app.server.port };
const session = (id: string, title: string, workspacePath: string) =>
  app.db.createSession({
    id,
    title,
    workspacePath,
    createdAt: new Date(at).toISOString(),
    lastActiveAt: new Date(at).toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
const refresh = async () => {
  const job = app.jobQueue.enqueue({
    queue: 'neo.work.driver.refresh',
    payload: { scope: 'neo' },
    runAt: Date.now(),
  });
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('driver refresh did not complete');
};
try {
  const db = app.db.getDatabase();
  await session(root, 'Synthetic Neo', neoFolder());
  await session(worker, 'Synthetic worker', join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  let seq = 0;
  const write = (type: string, body: object, offset: number, uuid: string, consumed?: number) => {
    seq += 1;
    db.prepare(`INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message,
      timestamp, sdk_uuid, consumed_seq, is_terminal, send_status, first_block_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed', ?)`).run(
      `row-${seq}`,
      worker,
      type,
      (body as { subtype?: string }).subtype ?? null,
      JSON.stringify({ type, uuid, ...body }),
      new Date(at + offset * 1000).toISOString(),
      uuid,
      consumed ?? null,
      Number(type === 'result'),
      'content' in body ? 'tool_result' : type === 'user' ? 'text' : null
    );
  };
  const input = (uuid: string, offset: number, consumed: number) =>
    write('user', { message: { content: 'Do it' } }, offset, uuid, consumed);
  const tool = (text: string, offset: number) =>
    write('user', { content: true, message: { content: [{ type: 'tool_result', content: text }] } }, offset, `tool-${offset}`);
  const result = (text: string, offset: number, consumed: number, subtype = 'success') =>
    write('result', { subtype, result: text }, offset, `end-${offset}`, consumed);

  input('first-input', 1, 1);
  tool('Created https://github.com/o/r/pull/7', 2);
  result('Opened https://github.com/o/r/pull/7', 3, 1);
  input('shared-a', 4, 2);
  input('shared-b', 5, 3);
  result('Stopped, see https://github.com/o/r/pull/1', 6, 3, 'error_during_execution');
  input('still-running', 7, 4);
  tool('https://example.com/not-finished', 8);

  const turns = new WorkTurnRepository(db);
  await refresh();
  const recorded = turns.list(ref);
  evidence.recorded = recorded;
  assert.deepEqual(
    recorded.map((turn) => [turn.inputs, turn.ended, turn.urls, turn.complete]),
    [
      [['first-input'], 'success', ['https://github.com/o/r/pull/7'], true],
      [['shared-a', 'shared-b'], 'error_during_execution', ['https://github.com/o/r/pull/1'], true],
    ]
  );

  result('Finished', 9, 4);
  db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(new Date().toISOString(), worker);
  await refresh();
  assert.equal(turns.list(ref).length, 3, 'the running turn is recorded once it ends');
  assert.deepEqual(turns.list(ref)[2].urls, ['https://example.com/not-finished']);
  evidence.afterTurnEnded = turns.list(ref)[2];
  evidence.verified = true;
  console.log('VERIFIED: finished turns are recorded with their inputs, ending and URLs; a running turn waits');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
