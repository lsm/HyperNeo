import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingWorkFactsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/work-facts.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));

const evidence = join(run, 'evidence');
const folder = join(run, 'project');
mkdirSync(evidence);
mkdirSync(folder);
const url = (number: number) => `https://github.com/synthetic/design/pull/${number}`;
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const ordinary = Array.from({ length: 100 }, (_, i) => ({ path: `src/file-${i}.ts` }));
const design = { path: 'docs/design/cache/expiry.md' };
const neighbor = { path: 'docs/design-notes/expiry.md' };
const view = (number: number, state: 'OPEN' | 'MERGED', files: typeof ordinary, changedFiles = files.length) =>
  writeFileSync(join(run, `pr-${number}.json`), JSON.stringify({
    url: url(number), state, headRefOid: head, baseRefOid: base, reviews: [], files, changedFiles,
  }));
view(1, 'OPEN', [design]);
view(2, 'MERGED', ordinary, 101);
view(3, 'MERGED', [neighbor]);
view(4, 'MERGED', [design]);

const filePage = (nodes: typeof ordinary, hasNextPage = false) => ({
  data: { repository: { pullRequest: {
    headRefOid: head, baseRefOid: base,
    files: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'cursor' : null } },
  } } },
});
writeFileSync(join(run, 'files-2.json'), JSON.stringify([filePage(ordinary, true), filePage([design])]));
writeFileSync(join(run, 'bin', 'gh'), `#!/bin/bash
printf '%s\\n' "$*" >> "${evidence}/gh.log"
case "$1 $2" in
  'pr view') cat "${run}/pr-\${3##*/}.json" ;;
  'api graphql') [[ "$*" == *CodingMergeFiles* && "$*" == *number=2* ]] && cat "${run}/files-2.json" ;;
  'api --hostname')
    case "$*" in
      */check-runs*) echo '{"check_runs":[]}' ;;
      */status*) echo '{"statuses":[]}' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: folder }),
    disableWorktrees: true,
  },
  verbose: false,
});
const observed: Record<string, unknown> = {};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const owner = 'neo:00000000-0000-4000-8000-000000000542';
  const actor = { source: 'internal' as const, role: 'neo' as const, sessionId: owner };
  const timestamp = new Date().toISOString();
  db.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(owner, 'Synthetic Neo', 'general', folder, timestamp, timestamp, 'active', '{}', '{}');
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });

  new CodingWorkFactsRepository(db).observe(url(2), 0, {
    url: url(2), head, state: 'MERGED', checks: 'none', review: 'none',
  }, Date.now());

  const finish = async (todoId: string) => {
    const result = await invokeOperation(registry, 'neo.todo.done', { todoId, reason: 'Work finished' }, actor);
    assert.equal(result.kind, 'completed', JSON.stringify(result));
    return result.value as { ok: boolean; reason?: string };
  };
  const planRefusal = async (number: number, legacy = false) => {
    const askId = `ask-${number}`;
    store.openAsk({
      id: askId, projectId: null, sessionId: owner, originMessageId: null,
      title: 'Synthetic work', request: 'Record the PR', createdAt: 1,
    });
    const todo = store.addTodo(`todo-${number}`, askId, {
      title: 'PR work', instruction: 'Implement the change', doneWhen: 'PR merged', named: null,
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url(number)] } },
    }, 1);
    assert.equal(todo.plan, undefined);
    if (legacy) {
      db.prepare('UPDATE neo_todos SET plan_check_json = ? WHERE id = ?')
        .run(JSON.stringify({ legacy: true }), todo.id);
    }
    const reply = await finish(todo.id);
    observed[number] = reply;
    return reply;
  };

  for (const number of [2, 1]) {
    const result = await planRefusal(number);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.reason ?? '', /^plan_steps_missing:/);
  }
  for (const number of [3, 4]) {
    const result = await planRefusal(number, number === 4);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const repeated = await finish('todo-2');
  observed.cached = repeated;
  assert.equal(repeated.ok, false, JSON.stringify(repeated));
  assert.match(repeated.reason ?? '', /^plan_steps_missing:/);
  const calls = readFileSync(join(evidence, 'gh.log'), 'utf8').split('\n');
  assert.equal(calls.filter((call) => call.includes('CodingMergeFiles')).length, 1);
  unlinkSync(join(run, 'files-2.json'));
  db.prepare('UPDATE pack_coding_work_facts SET observed_at = 0 WHERE url = ?').run(url(2));
  const unavailableFiles = await finish('todo-2');
  observed.unavailableFiles = unavailableFiles;
  assert.equal(unavailableFiles.ok, false, JSON.stringify(unavailableFiles));
  assert.match(unavailableFiles.reason ?? '', /^plan_steps_missing:/);
  const refreshedCalls = readFileSync(join(evidence, 'gh.log'), 'utf8').split('\n');
  assert.equal(refreshedCalls.filter((call) => call.includes('CodingMergeFiles')).length, 2);
  console.log(`PASS: ${Object.keys(observed).length} todo completion replies with a successful and a failed paginated PR file read`);
} finally {
  writeFileSync(join(evidence, 'observed.json'), JSON.stringify(observed, null, 2));
  await app.cleanup();
}
