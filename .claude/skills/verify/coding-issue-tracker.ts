import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { neoTrackerReads } from '../../../packages/daemon/src/storage/repositories/neo-tracker-mirror.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const statePath = join(run, 'external.json');
type External = {
  issues: {
    id: number;
    repo: string;
    number: number;
    body: string;
    state: string;
    state_reason?: string;
  }[];
  links: Record<string, number[]>;
};
const external = (): External => JSON.parse(readFileSync(statePath, 'utf8'));
if (process.argv.includes('--seed') || process.argv.includes('--recover')) {
  const app = await createDaemonApp({
    config: {
      ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
      disableWorktrees: true,
    },
    verbose: false,
  });
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  await app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  const neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  const add = (id: string, repo: string, askId = 'ask') =>
    store.addTodo(
      id,
      askId,
      { title: id, instruction: null, named: null, check: null, doneWhen: 'Done' },
      2,
      `github.com/${repo}`
    );
  try {
    if (process.argv.includes('--seed')) {
      store.openAsk({
        id: 'ask',
        projectId: null,
        sessionId: 'synthetic',
        originMessageId: null,
        title: 'Synthetic plan',
        request: 'Private details',
        createdAt: 1,
      });
      add('one', 'example/one');
      add('two', 'example/two');
      const declaration = neo.pack('coding')!.preferences!.mirror_issues;
      assert.equal(declaration.default, false);
      assert.equal(declaration.scope, 'repo');
      await neo.sweepPacks();
      assert(!existsSync(statePath), 'Default-off preference must create no issues');
      for (const repo of ['Example/One', 'example/two'])
        app.db
          .getDatabase()
          .prepare(
            "INSERT INTO neo_pack_preferences VALUES ('coding','repo',?,'mirror_issues','true','human',1)"
          )
          .run(repo);
      const gateway = app.db.gateway;
      const original = gateway.run.bind(gateway);
      gateway.run = (async (op, args) => {
        const input = args as { args?: [{ state: string }] };
        if (op.name === 'neo.tracker.write' && input.args?.[0].state === 'bound') {
          writeFileSync(join(run, 'seed-ready.json'), JSON.stringify({ port: app.server.port }));
          await new Promise(() => {});
        }
        return original(op, args);
      }) as typeof gateway.run;
      await neo.sweepPacks();
    } else {
      await neo.sweepPacks();
      assert.equal(
        external().issues.filter((issue) => issue.body.includes('hyperneo:ask:ask')).length,
        1
      );
      await neo.sweepPacks();
      assert.deepEqual(external().links['example/one#1'], [2, 3]);
      await neo.sweepPacks();
      assert.deepEqual(external().links['example/one#1'], [2, 3]);
      add('late', 'example/one');
      await neo.sweepPacks();
      await neo.sweepPacks();
      assert.equal(external().issues.length, 4);
      assert.deepEqual(external().links['example/one#1'], [2, 3, 4]);
      assert(external().issues.every((issue) => !issue.body.includes('Private details')));
      app.db.getDatabase().prepare("UPDATE neo_todos SET state = 'done'").run();
      await neo.sweepPacks();
      app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'done'").run();
      await neo.sweepPacks();
      assert(
        external().issues.every(
          (issue) => issue.state === 'closed' && issue.state_reason === 'completed'
        )
      );
      store.openAsk({
        id: 'timeout',
        projectId: null,
        sessionId: 'synthetic',
        originMessageId: null,
        title: 'Timeout plan',
        request: 'Private details',
        createdAt: 3,
      });
      add('timeout-child', 'example/one', 'timeout');
      writeFileSync(join(run, 'slow-create'), 'enabled');
      const began = Date.now();
      await neo.sweepPacks();
      const elapsedMs = Date.now() - began;
      assert(elapsedMs >= 30_000);
      const pid = JSON.parse(readFileSync(join(run, 'hung-gh.json'), 'utf8')).pid as number;
      let alive = true;
      for (let attempt = 0; attempt < 100 && alive; attempt++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(10);
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, 'Timed-out gh process must be dead');
      assert(!external().issues.some((issue) => issue.body.includes('hyperneo:ask:timeout')));
      const facts = await app.db.gateway.call(neoTrackerReads, 'facts');
      assert.equal(facts.mirrors.find((row) => row.ownerId === 'timeout')?.failures, 1);
      unlinkSync(join(run, 'slow-create'));
      await neo.sweepPacks();
      await neo.sweepPacks();
      assert.equal(
        external().issues.filter((issue) => issue.body.includes('hyperneo:ask:timeout')).length,
        1
      );
      const privateIssueCount = external().issues.length;
      store.openAsk({
        id: 'public',
        projectId: null,
        sessionId: 'synthetic',
        originMessageId: null,
        title: 'Private plan title',
        request: 'Private details',
        createdAt: 4,
      });
      add('public-child', 'example/public', 'public');
      app.db
        .getDatabase()
        .prepare(
          "INSERT INTO neo_pack_preferences VALUES ('coding','repo','example/public','mirror_issues','true','human',2)"
        )
        .run();
      for (let attempt = 0; attempt < 4; attempt++) await neo.sweepPacks();
      assert.equal(external().issues.length, privateIssueCount);
      const refused = await app.db.gateway.call(neoTrackerReads, 'facts');
      const publicRows = refused.mirrors.filter(
        (row) => row.ownerId === 'public' || row.ownerId === 'public-child'
      );
      assert.equal(publicRows.length, 2);
      assert(publicRows.every((row) => row.failures === 3));
      const sends: string[] = [],
        notes: string[] = [];
      let rejectNotes = false;
      const sessions = new NeoTodoSessionRepository(app.db.getDatabase());
      const runner = createNeoTodoRunner({
        store,
        sessions,
        write: (op, args) => app.db.gateway.run(op, args),
        packs: () => neo.packs(),
        limits: () => ({ running: 9, perGroup: 9 }),
        changed: () => {},
        tell: async (_ask, _todo, note) => {
          if (rejectNotes) throw new Error('Synthetic mailbox failure');
          notes.push(note);
        },
        invoke: async (_caller, name, input) => {
          if (name === 'work.send') sends.push(String(input.message));
          return {
            kind: 'completed',
            value: { ok: true, value: { status: 'done', delivered: true, ref: input.ref } },
          };
        },
      });
      const prepareStart = (id: string) => {
        store.updateTodo(
          store.getTodo(id)!,
          { instruction: 'Synthetic worker task', approvedAt: 1, dependsOn: [] },
          Date.now()
        );
        sessions.create(id, { verb: 'send', ref: { adapter: 'hyperneo', id: `worker-${id}` } });
      };
      store.openAsk({
        id: 'hold',
        projectId: null,
        sessionId: 'synthetic',
        originMessageId: null,
        title: 'Held plan',
        request: 'Work',
        createdAt: Date.now(),
      });
      add('held', 'example/one', 'hold');
      prepareStart('held');
      const held = await runner.start('held');
      assert(!held.ok && held.reason.startsWith('tracker_pending:'));
      await runner.fill();
      assert.equal(sends.length, 0);
      await neo.sweepPacks();
      await runner.fill();
      assert.equal(sends.length, 1);
      prepareStart('public-child');
      await runner.fill();
      assert.equal(sends.length, 2);
      assert(notes.some((note) => note.includes('Tracker item is missing')));
      const adapter = neo.pack('coding')!.tracker!;
      const originalHome = adapter.home;
      const beforeNoHome = external().issues.length;
      adapter.home = () => null;
      store.openAsk({
        id: 'no-home-ask',
        projectId: null,
        sessionId: 'synthetic',
        originMessageId: null,
        title: 'No home plan',
        request: 'Work',
        createdAt: Date.now(),
      });
      add('no-home', 'example/one', 'no-home-ask');
      prepareStart('no-home');
      for (let failures = 1; failures <= 3; failures++) {
        await neo.sweepPacks();
        const facts = await app.db.gateway.call(neoTrackerReads, 'facts');
        assert.equal(facts.mirrors.find((row) => row.ownerId === 'no-home')?.failures, failures);
        if (failures < 3) {
          await runner.fill();
          assert.equal(sends.length, 2);
        }
      }
      await runner.fill();
      assert.equal(sends.length, 3);
      assert.equal(external().issues.length, beforeNoHome);
      adapter.home = originalHome;
      adapter.home = () => null;
      store.openAsk({
        id: 'retired',
        projectId: null,
        sessionId: 'synthetic',
        originMessageId: null,
        title: 'Retired plan',
        request: 'Work',
        createdAt: Date.now(),
      });
      add('retired-child', 'example/one', 'retired');
      await neo.sweepPacks();
      store.updateTodo(store.getTodo('retired-child')!, { state: 'removed' }, Date.now());
      app.db.getDatabase().prepare("UPDATE neo_asks SET status='dropped' WHERE id='retired'").run();
      adapter.home = originalHome;
      const beforeRetire = external().issues.length;
      await neo.sweepPacks();
      assert.equal(external().issues.length, beforeRetire);
      const retired = app.db
        .getDatabase()
        .prepare(
          "SELECT state, ref FROM neo_tracker_mirrors WHERE owner_id IN ('retired','retired-child')"
        )
        .all() as { state: string; ref: string | null }[];
      assert.equal(retired.length, 2);
      assert(retired.every((row) => row.state === 'closed' && row.ref === null));
      add('note-error', 'example/public', 'public');
      prepareStart('note-error');
      for (let attempt = 0; attempt < 3; attempt++) await neo.sweepPacks();
      rejectNotes = true;
      await runner.fill();
      assert.equal(sends.length, 4);
      writeFileSync(
        join(run, 'evidence/observed.json'),
        JSON.stringify({
          parentCreateCount: 1,
          failedNoteReleasedSends: 1,
          retiredPlaceholderCount: 2,
          retiredExternalCreateCount: 0,
          noHomeFailures: 3,
          noHomeCreateCount: 0,
          noHomeReleasedSends: 1,
          heldSends: 0,
          boundSends: 1,
          cappedSends: 1,
          missingTrackerNote: true,
          publicCreateCount: 0,
          publicFailureCounts: publicRows.map((row) => row.failures),
          crossRepoChildren: true,
          lateStep: true,
          completedClose: true,
          timedOutPid: pid,
          processAlive: alive,
          elapsedMs,
          issueCount: external().issues.length,
        })
      );
    }
  } finally {
    await neo.dispose();
    await app.cleanup();
  }
} else {
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(
    join(run, 'bin/gh'),
    `#!/usr/bin/python3
import json, os, sys, time
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
endpoint = next((arg for arg in args if arg.startswith('repos/')), None)
if endpoint is None: sys.exit(2)
method = args[args.index('--method') + 1] if '--method' in args else 'GET'
fields = {}
for i, arg in enumerate(args[:-1]):
  if arg in ('-f', '-F'):
    key, value = args[i + 1].split('=', 1)
    fields[key] = int(value) if arg == '-F' else value
path = os.path.join(root, 'external.json')
state = json.load(open(path)) if os.path.exists(path) else {'issues': [], 'links': {}}
parts = endpoint.split('/')
repo = '/'.join(parts[1:3])
number = int(parts[4]) if len(parts) > 4 else None
key = repo + '#' + str(number)
if len(parts) == 3:
  result = {'private': repo != 'example/public'}
elif len(parts) == 4 and method == 'POST':
  if os.path.exists(os.path.join(root, 'slow-create')) and 'hyperneo:ask:timeout' in fields['body']:
    json.dump({'pid': os.getpid()}, open(os.path.join(root, 'hung-gh.json'), 'w'))
    time.sleep(60)
  result = {'id': len(state['issues']) + 1, 'repo': repo, 'number': sum(issue['repo'] == repo for issue in state['issues']) + 1, 'body': fields['body'], 'state': 'open'}
  state['issues'].append(result)
elif len(parts) == 4:
  start = (int(fields.get('page', 1)) - 1) * 100
  result = [issue for issue in state['issues'] if issue['repo'] == repo][start:start + 100]
elif len(parts) == 6 and method == 'POST':
  state['links'].setdefault(key, []).append(fields['sub_issue_id'])
  result = {}
elif len(parts) == 6:
  result = [[issue for issue in state['issues'] if issue['id'] in state['links'].get(key, [])]]
else:
  result = next(issue for issue in state['issues'] if issue['repo'] == repo and issue['number'] == number)
  if method == 'PATCH': result.update(fields)
json.dump(state, open(path, 'w'))
print(json.dumps(result))
`,
    { mode: 0o700 }
  );
  const seed = Bun.spawn([process.execPath, import.meta.path, '--seed', run], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const seedOut = new Response(seed.stdout).text(),
    seedErr = new Response(seed.stderr).text();
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(run, 'seed-ready.json')) && Date.now() < deadline) await Bun.sleep(100);
    assert(existsSync(join(run, 'seed-ready.json')));
  } finally {
    seed.kill('SIGKILL');
    await seed.exited;
    writeFileSync(join(run, 'evidence/seed.log'), (await seedOut) + (await seedErr));
  }
  const recovery = Bun.spawn([process.execPath, import.meta.path, '--recover', run], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = new Response(recovery.stdout).text(),
    err = new Response(recovery.stderr).text();
  const exit = await recovery.exited;
  writeFileSync(join(run, 'evidence/recovery.log'), (await out) + (await err));
  assert.equal(exit, 0);
  console.log(
    'PASS: GitHub adapter service sweep; parentCreateCount=1; recoveryExit=0; timedOutGhAlive=false; publicCreateCount=0'
  );
}
