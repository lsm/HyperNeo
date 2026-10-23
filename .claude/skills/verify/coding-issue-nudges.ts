import { ExternalEventService } from '../../../packages/daemon/src/lib/external-events/external-event-service.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const [mode, directory] = process.argv.slice(2),
  run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const d of ['home/.codex/app-server-control', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, d), { recursive: true });
const root = 'neo:10000000-0000-4000-8000-000000008231',
  at = Date.now();
let clock = at;
const realNow = Date.now;
Date.now = () => clock;
const report = 'Complete coding issue report 🦊';
const issues = Object.fromEntries(
  [1, 2, 3, 4, 5].map((n) => [
    n,
    {
      __typename: 'Issue',
      url: `https://github.com/synthetic/plan/issues/${n}`,
      title: `Synthetic issue ${n}`,
      state: n === 1 || n === 3 ? 'CLOSED' : 'OPEN',
      stateReason: n === 1 ? 'COMPLETED' : n === 3 ? 'NOT_PLANNED' : null,
      closedAt: new Date(at).toISOString(),
      createdAt: new Date(at - 60000).toISOString(),
      closedByPullRequestsReferences: { nodes: [] },
    },
  ])
);
writeFileSync(join(run, 'issues.json'), JSON.stringify(issues));
writeFileSync(
  join(run, 'bin/gh'),
  `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
fs.appendFileSync(root+'/evidence/gh.log',JSON.stringify(args)+String.fromCharCode(10));
if(args[0]!=='api'||args[1]!=='graphql')process.exit(2);
if(args.includes('n=plan')&&!args.some(s=>s.startsWith('p='))){process.stdout.write(fs.readFileSync(root+'/ledger.json','utf8'));process.exit(0);}
const n=Number(args.find(s=>s.startsWith('p='))?.slice(2));
if(n===4)process.exit(2);
const issue=JSON.parse(fs.readFileSync(root+'/issues.json','utf8'))[n];
if(!issue)process.exit(2);
process.stdout.write(JSON.stringify({data:{repository:{defaultBranchRef:{name:'dev'},issueOrPullRequest:issue}}}));
`,
  { mode: 0o700 }
);
const state = new Database(join(run, 'home/.codex/state_5.sqlite'));
state.exec(
  'CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER);CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)'
);
for (const id of ['flow', 'nudge']) {
  const rollout = join(run, `home/.codex/${id}.jsonl`);
  writeFileSync(
    rollout,
    JSON.stringify({
      timestamp: new Date(at - 60000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'Prior synthetic turn' },
    }) + '\n'
  );
  state
    .prepare("INSERT INTO threads VALUES (?,?,'','',?,'vscode',0,?,?,NULL)")
    .run(id, id, join(run, 'workspace'), at - 60000, rollout);
}
state.close();
const calls: Record<string, unknown>[] = [];
const peer = Bun.serve({
  unix: join(run, 'home/.codex/app-server-control/app-server-control.sock'),
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('websocket', { status: 400 });
  },
  websocket: {
    message(socket, bytes) {
      const call = JSON.parse(String(bytes));
      if (!('id' in call)) return;
      calls.push(call);
      if (call.method === 'turn/start') {
        const input = call.params.input
          .map((part: { text?: string }) => part.text ?? '')
          .join('\n');
        writeFileSync(
          join(run, `home/.codex/${call.params.threadId}.jsonl`),
          JSON.stringify({
            timestamp: new Date(clock).toISOString(),
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: input }],
            },
          }) + '\n',
          { flag: 'a' }
        );
      }
      const result =
        call.method === 'thread/turns/list'
          ? { data: [] }
          : call.method === 'thread/resume'
            ? { thread: { id: call.params.threadId, status: { type: 'idle' }, turns: [] } }
            : call.method === 'turn/start'
              ? { turn: { id: crypto.randomUUID() } }
              : {};
      socket.send(JSON.stringify({ id: call.id, jsonrpc: '2.0', result }));
    },
  },
});
const evidence: Record<string, unknown> = {
  mode,
  calls,
  daemonPorts: [] as number[],
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
let store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository;
const starts = () => calls.filter((c) => c.method === 'turn/start').length;
const open = async () => {
  app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  (evidence.daemonPorts as number[]).push(app.server.port);
  store = new NeoAskTodoRepository(app.db.getDatabase());
  sessions = new NeoTodoSessionRepository(app.db.getDatabase());
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('RPC unavailable'));
  });
};
const rpc = (name: string, input: unknown) =>
  new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(),
      timer = setTimeout(() => fail(new Error(name + ' timeout')), 20000);
    ws!.onmessage = (e) => {
      const r = JSON.parse(String(e.data));
      if (r.id !== id && r.requestId !== id) return;
      clearTimeout(timer);
      r.error ? fail(new Error(JSON.stringify(r.error))) : done(r.data);
    };
    ws!.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method: 'operation.invoke',
        data: { name, input },
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
const refresh = async (queue = 'neo.work.driver.refresh') => {
  const job = app!.jobQueue.enqueue({
      queue,
      payload: { scope: 'neo' },
      runAt: realNow(),
    }),
    deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app!.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return current;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    'Driver refresh did not complete: ' + JSON.stringify(app!.jobQueue.getJob(job.id))
  );
};
const ask = (id: string) =>
  store.openAsk({
    id,
    title: id,
    request: 'Synthetic ordered work',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: at,
  });
const add = (id: string, askId: string, n: number, worker?: string, doing = false) => {
  const todo = store.addTodo(
    id,
    askId,
    {
      title: id,
      doneWhen: 'Issue completed',
      check: { pack: 'coding', kind: 'issue_closed', params: { issue: `synthetic/plan#${n}` } },
      instruction: worker ? `Perform ${id}` : null,
      named: null,
    },
    at
  );
  if (worker) sessions.create(id, { verb: 'send', ref: { adapter: 'codex-desktop', id: worker } });
  if (doing) {
    sessions.recordRef(id, { adapter: 'codex-desktop', id: worker! }, at);
    store.updateTodo(todo, { state: 'doing', startedAt: at, report }, at);
  }
};
try {
  await open();
  app!.db.createSession({
    id: root,
    title: 'Synthetic coding facts',
    workspacePath: join(run, 'workspace'),
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
  new NeoRepository(app!.db.getDatabase()).reserveBinding({
    sessionId: root,
    kind: 'neo',
    projectId: null,
  });
  ask('flow');
  add('first', 'flow', 1, 'flow', true);
  add('next', 'flow', 2, 'flow');
  ask('failed');
  add('not-planned', 'failed', 3);
  add('after-failed', 'failed', 2, 'flow');
  ask('unreadable');
  add('unreadable', 'unreadable', 4);
  clock = at;
  await refresh();
  evidence.completion = {
    first: store.getTodo('first'),
    next: store.getTodo('next'),
    failed: store.getTodo('not-planned'),
    afterFailed: store.getTodo('after-failed'),
    unreadable: store.getTodo('unreadable'),
    starts: starts(),
  };
  evidence.snapshot = await rpc('neo.snapshot', {});
  if (mode === 'before') {
    assert.notEqual(store.getTodo('first')?.state, 'done');
    console.log('REPRODUCED: COMPLETED issue does not advance the stopped-worker plan.');
  } else {
    assert.equal(store.getTodo('first')?.state, 'done');
    assert.equal(store.getTodo('first')?.report, report);
    assert.equal(store.getTodo('next')?.state, 'doing');
    assert.equal(store.getTodo('not-planned')?.state, 'failed');
    assert.equal(store.getTodo('after-failed')?.state, 'todo');
    assert.equal(store.getTodo('unreadable')?.state, 'todo');
    assert.equal(starts(), 1);
    await refresh();
    assert.equal(starts(), 1);
    ws!.close();
    await app!.cleanup();
    app = undefined;
    await open();
    await refresh();
    assert.equal(starts(), 1);
    ask('start-failure');
    add('start-failure', 'start-failure', 2);
    store.updateTodo(
      store.getTodo('start-failure')!,
      {
        state: 'blocked',
        blockedBy: 'failure',
        blockedReason: 'Could not start: needs_you',
      },
      clock
    );
    await refresh();
    evidence.failureBlock = store.getTodo('start-failure');
    assert.equal(store.getTodo('start-failure')?.state, 'blocked');
    assert.equal(store.getTodo('start-failure')?.blockedBy, 'failure');
    ask('nudges');
    const baseline = clock;
    add('nudge', 'nudges', 5, 'nudge', true);
    store.updateTodo(store.getTodo('nudge')!, { startedAt: baseline }, baseline);
    const reminders = () =>
      calls.filter((call: any) => call.method === 'turn/start' && call.params.threadId === 'nudge')
        .length;
    const ladder = [];
    for (const minutes of [19, 20, 21, 40, 60, 120]) {
      clock = baseline + minutes * 60000;
      await refresh();
      const row = app!.db
        .getDatabase()
        .prepare(
          "SELECT value_json FROM pack_facts WHERE todo_id='nudge' AND pack='core' AND key='nudge'"
        )
        .get() as { value_json: string } | null;
      ladder.push({
        minutes,
        todo: store.getTodo('nudge'),
        incident: row ? JSON.parse(row.value_json) : null,
        reminders: reminders(),
      });
      if (minutes === 20 || minutes === 40) {
        ws!.close();
        await app!.cleanup();
        app = undefined;
        await open();
      }
    }
    evidence.ladder = ladder;
    assert.deepEqual(
      ladder.map((row) => row.reminders),
      [0, 1, 1, 2, 2, 2]
    );
    assert(ladder.every((row) => row.todo?.state === 'doing'));
    assert.equal(ladder.at(-1)!.incident.nudges, 3);
    ask('legacy');
    const legacyUrl = 'https://github.com/synthetic/plan/pull/9';
    const legacy = store.addTodo(
      'legacy',
      'legacy',
      {
        title: 'Legacy PR',
        doneWhen: 'PR merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [legacyUrl] } },
        instruction: 'Synthetic legacy stage',
        named: null,
      },
      clock
    );
    sessions.create(legacy.id, { verb: 'send', ref: { adapter: 'codex-desktop', id: 'flow' } });
    sessions.recordRef(legacy.id, { adapter: 'codex-desktop', id: 'flow' }, clock);
    store.updateTodo(legacy, { state: 'doing', report: 'Waiting for CI', startedAt: clock }, clock);
    const prs = new CodingTodoPrRepository(app!.db.getDatabase());
    prs.claim(legacy.id, [{ url: legacyUrl, claim: 'named' }], clock);
    prs.record(
      legacy.id,
      [{ url: legacyUrl, state: 'OPEN', checks: 'failing', review: 'none' }],
      clock
    );
    app!.db.getDatabase().prepare('INSERT INTO neo_card_event_subscriptions(work_id,topic,created_at) VALUES (?,?,?)').run(
      legacy.id,
      'github/synthetic/plan/pull_request/9.*',
      clock
    );
    const beforeFrames = starts();
    await new ExternalEventService(
      new SessionExternalEventStore(app!.db.getDatabase()),
      app!.internalEventBus
    ).publish({
      id: 'raw-ci',
      spaceId: SESSION_EVENT_SCOPE,
      source: 'github',
      topic: 'github/synthetic/plan/pull_request/9.check_failed',
      dedupeKey: 'raw-ci',
      occurredAt: clock,
      ingestedAt: clock,
      summary: 'Synthetic raw CI failure',
      payload: {
        prUrl: legacyUrl,
        prNumber: 9,
        checkName: 'Synthetic raw CI',
        conclusion: 'failure',
      },
    });
    evidence.rawPrEvent = { beforeFrames, afterFrames: starts() };
    assert.equal(starts(), beforeFrames, 'raw PR events must not duplicate ledger worker messages');
    const db = app!.db.getDatabase();
    db.prepare("INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES ('ledger-proof','Synthetic','','',1,?,?)").run(clock, clock);
    db.prepare("INSERT INTO neo_project_workspaces(alias,project_id) VALUES ('repo:synthetic/plan','ledger-proof')").run();
    const ledger = (ci: string) => ({ data: {
      rateLimit: { remaining: 4000 },
      repository: { nameWithOwner: 'synthetic/plan',
        open: { pageInfo: { hasNextPage: false }, nodes: [{ number: 9,
          title: 'Synthetic claimed PR', headRefName: 'synthetic', headRefOid: 'a'.repeat(40),
          state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null,
          reviews: { nodes: [] }, closedAt: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
        }] }, done: { nodes: [] },
      },
    } });
    const beforeLedger = starts();
    writeFileSync(join(run, 'ledger.json'), JSON.stringify(ledger('SUCCESS')));
    await refresh('neo.pack.sweep');
    assert.equal(starts(), beforeLedger);
    writeFileSync(join(run, 'ledger.json'), JSON.stringify(ledger('FAILURE')));
    await refresh('neo.pack.sweep');
    assert.equal(starts(), beforeLedger + 1, 'claimed PR must receive its ledger CI event');
    await refresh('neo.pack.sweep');
    assert.equal(starts(), beforeLedger + 1, 'unchanged ledger facts must not resend');
    const delivered = calls.filter((call: any) => call.method === 'turn/start').slice(beforeLedger);
    assert.match(JSON.stringify(delivered), /synthetic\/plan#9.*has failing CI/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM pack_coding_pr_claims WHERE todo_id='legacy'").get().n, 1);
    evidence.ledgerClaimDelivery = { beforeFrames: beforeLedger, afterFrames: starts(), delivered };
    evidence.verified = true;
    console.log(
      'VERIFIED: issue completion advances once; NOT_PLANNED fails; open/unreadable wait; 20/40/60 nudges persist without blocking.'
    );
  }
} finally {
  Date.now = realNow;
  ws?.close();
  await app?.cleanup();
  peer.stop(true);
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
