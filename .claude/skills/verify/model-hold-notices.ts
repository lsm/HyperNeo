import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { frontSessionId } from '../../../packages/daemon/src/lib/neo/front-mode.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['workspace', 'evidence', 'bin'])
  mkdirSync(join(run, name), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
const evidence: unknown[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('External HTTP disabled');
}) as typeof fetch;
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: join(run, 'workspace'),
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const raw = app.db.getDatabase();
  const root = 'neo:00000000-0000-4000-8000-00000000a777';
  raw
    .prepare(
      'INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(
      root,
      'Synthetic Neo',
      join(run, 'workspace'),
      new Date().toISOString(),
      new Date().toISOString(),
      'active',
      JSON.stringify({ provider: 'anthropic', model: 'synthetic' }),
      '{}'
    );
  raw.prepare("INSERT INTO neo_session_bindings (session_id,kind) VALUES (?,'neo')").run(root);
  const front = frontSessionId(root.slice(4));
  raw
    .prepare(
      'INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) SELECT ?,title,workspace_path,created_at,last_active_at,status,config,metadata FROM sessions WHERE id = ?'
    )
    .run(front, root);
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('RPC connection failed'));
  });
  const notices: unknown[] = [];
  const pending = new Map<string, (reply: { data: unknown; error?: unknown }) => void>();
  ws.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.method === 'neo.session.notice') notices.push(reply.data);
    pending.get(reply.requestId ?? reply.id)?.(reply);
  };
  const rpc = (name: string) =>
    new Promise<Record<string, unknown>>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error('Snapshot timed out')), 10000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        pending.delete(id);
        if (reply.error) fail(new Error(JSON.stringify(reply.error)));
        else done(reply.data as Record<string, unknown>);
      });
      ws!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          sessionId: 'global',
          method: 'operation.invoke',
          data: { name, input: {} },
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });
  const refresh = async (label: string) => {
    raw
      .prepare('UPDATE job_queue SET run_at = ? WHERE status = ?')
      .run(Date.now() + 86400000, 'pending');
    raw
      .prepare(
        "UPDATE job_queue SET run_at = 0 WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'"
      )
      .run();
    const claimed = await app.jobProcessor.tick();
    await app.jobProcessor.stop();
    assert(claimed >= 1, 'the real refresh job must run');
    const snapshot = await rpc('neo.snapshot');
    evidence.push({ label, claimed, snapshot, noticeEvents: [...notices] });
    return snapshot.sessionNotices as unknown[];
  };
  const state = (value: Record<string, unknown>) =>
    raw
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(JSON.stringify(value), root);
  const since = Date.now();
  await rpc('neo.snapshot');
  state({ status: 'rate_limit_cooldown', reason: 'login', since });
  raw
    .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'rate_limit_cooldown', reason: 'login', since: since - 1 }), front);
  assert.equal((await refresh('login hold')).length, 1);
  assert.equal(notices.length, 1);
  raw
    .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'idle' }), front);
  assert.equal((await refresh('same hold')).length, 1);
  assert.equal(notices.length, 1);
  state({ status: 'idle' });
  assert.equal((await refresh('login recovered')).length, 0);
  state({ status: 'rate_limit_cooldown', reason: 'limit', since, retryAt: since + 31 * 60000 });
  assert.equal((await refresh('long limit')).length, 1);
  assert.equal(notices.length, 2);
  state({ status: 'processing', phase: 'thinking' });
  assert.equal((await refresh('limit recovered')).length, 0);
  state({
    status: 'rate_limit_cooldown',
    reason: 'limit',
    since: Date.now(),
    retryAt: Date.now() + 5 * 60000,
  });
  assert.equal((await refresh('short limit')).length, 0);
  assert.equal(notices.length, 2);
  console.log(
    'PASS: real refresh jobs, authenticated snapshots and notice events agree. alerts=2; duplicateAlerts=0; recoveredNotices=0; shortLimitAlerts=0'
  );
} finally {
  ws?.close();
  await app.cleanup();
  globalThis.fetch = realFetch;
  writeFileSync(join(run, 'evidence/model-hold-notices.json'), JSON.stringify(evidence, null, 2));
}
