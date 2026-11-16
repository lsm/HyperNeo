process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
globalThis.fetch = (() => {
  throw new Error('External HTTP is disabled');
}) as typeof fetch;
const HOUR = 3_600_000;
const at = Date.now();
const realNow = Date.now;
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = { checks: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: join(run, 'workspace'),
      }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const db = app.db.getDatabase();
  const root = 'neo:00000000-0000-4000-8000-00000000a771';
  db.prepare(
    'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    root,
    'Synthetic Neo',
    'general',
    join(run, 'workspace'),
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    'active',
    '{}',
    '{}'
  );
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(root);
  const { todos, todoSessions } = service;
  todos.openAsk({
    id: 'ask',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    title: 'Synthetic ask',
    request: 'Synthetic work',
    createdAt: at,
  });
  const add = (id: string) =>
    todos.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Merged',
        check: null,
        named: null,
        instruction: 'Ship the synthetic change.',
        approvedAt: at,
        dependsOn: [],
      },
      at
    );
  const worker = (id: string, live: string) => {
    const ref = { adapter: 'hyperneo', id: `worker-${id}` };
    todoSessions.create(id, { verb: 'send', ref });
    todoSessions.recordRef(id, ref, at);
    todos.updateTodo(todos.getTodo(id)!, { state: 'doing', startedAt: at }, at);
    todoSessions.recordNudge(id, { since: at, nudges: 0, live });
  };
  const pr = (id: string, number: number, state: string, closedAt: number | null) => {
    const url = `https://github.com/acme/synthetic/pull/${number}`;
    db.prepare(
      'INSERT INTO pack_coding_todo_prs (todo_id, prs_json, read_at) VALUES (?, ?, ?)'
    ).run(id, JSON.stringify([{ url, state: closedAt ? 'MERGED' : 'OPEN' }]), at);
    db.prepare(
      `INSERT INTO pack_coding_pr_ledger
         (repo, number, title, branch, head, state, state_since, closed_at, read_at)
       VALUES ('acme/synthetic', ?, ?, 'b', 'abc1234', ?, ?, ?, ?)`
    ).run(number, id, state, at, closedAt, at);
  };
  add('idle-step');
  worker('idle-step', 'done');
  pr('idle-step', 1, 'waiting_review', null);
  add('running-step');
  worker('running-step', 'running');
  pr('running-step', 2, 'waiting_review', null);
  add('merged-step');
  worker('merged-step', 'done');
  pr('merged-step', 3, 'merged', at);
  const queue = (name: string) =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = ?
              AND json_extract(payload, '$.to.sessionId') = ? ORDER BY created_at, rowid`
        )
        .all(name, root) as { text: string }[]
    ).map((row) => String(row.text));
  const sweep = async (name: string, hours: number) => {
    clock = at + hours * HOUR;
    await service!.sweepPacks();
    await service!.sweepPacks();
    const told = { digests: queue('neo_notes'), wakes: queue('mailbox') };
    (evidence.checks as unknown[]).push({ name, hours, ...told });
    return told;
  };
  const idle = (state: string) =>
    `Todo "idle-step" (idle-step) has an idle worker and an open pull request: https://github.com/acme/synthetic/pull/1 (${state}). Continue its worker if the pull request needs work; otherwise it waits on review, CI or the merge.`;
  const first = await sweep('two sweeps at the start', 0);
  assert.deepEqual(first.digests, [idle('waiting for review')], 'only the idle step, once');
  const early = await sweep('two sweeps an hour later', 1);
  assert.equal(early.digests.length, 1, 'no repeat before the 4 h rung');
  const rung = await sweep('two sweeps after the 4 h rung', 4);
  assert.equal(rung.digests.length, 2, 'one more at the 4 h rung');
  db.prepare(
    "UPDATE pack_coding_pr_ledger SET state = 'failing', state_since = ? WHERE number = 1"
  ).run(at + 5 * HOUR);
  const changed = await sweep('after the pull request starts failing', 5);
  assert.equal(changed.digests.at(-1), idle('failing CI'), 'a state change is told anew');
  todoSessions.recordNudge('idle-step', { since: at + 6 * HOUR, nudges: 0, live: 'running' });
  const resumed = await sweep('after the worker runs again', 10);
  assert.equal(resumed.digests.length, 3, 'a running worker is not told');
  assert(
    resumed.wakes.every((text) => text.startsWith('Todo "merged-step" (merged-step) needs')),
    'only the merged step, whose pull request no longer waits, wakes Neo'
  );
  evidence.passed = true;
  console.log('PASS');
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  Date.now = realNow;
  writeFileSync(
    join(run, 'evidence/neo-coding-idle-open-pr.json'),
    JSON.stringify(evidence, null, 2)
  );
}
