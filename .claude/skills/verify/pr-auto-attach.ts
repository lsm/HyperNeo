import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { WorkTurnRepository } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';
import { CodingTurnPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/turn-prs.ts';
import { CodingPrLedgerRepository, planCodingLedgerTurnOwner } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository, deliverCodingPrEvents } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { createCodingDaemonMergeSweep } from '../../../packages/daemon/src/lib/neo/packs/coding/daemon-merge-sweep.ts';
import { initializeCodingWatches } from '../../../packages/daemon/src/lib/neo/packs/coding/watched-repos.ts';
import type { SpawnFn } from '../../../packages/daemon/src/lib/runtime-spawn/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  db.prepare("DELETE FROM neo_pack_preferences WHERE pack='coding' AND key='watchedRepos'").run();
  initializeCodingWatches(db, ['synthetic/owner']);
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const turns = new WorkTurnRepository(db);
  const ledger = new CodingPrLedgerRepository(db);
  const events = new CodingPrEventRepository(db);
  const at = Date.now();
  const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40);
  const url = (number: number) => `https://github.com/synthetic/owner/pull/${number}`;
  const worker = (number: number) => ({ adapter: 'codex-desktop', id: `synthetic-worker-${number}` });
  const insert = db.prepare(`INSERT INTO pack_coding_pr_ledger
    (repo,number,title,branch,head,state,state_since,read_at,created_at)
    VALUES ('synthetic/owner',?,'Change','work',?,'waiting_review',?,?,?)`);
  const seed = (id: string, number: number, repo = 'github.com/synthetic/owner') => {
    const askId = `ask-${id}`;
    todos.openAsk({ id: askId, sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: id, request: 'Open a PR', createdAt: at - 3000 });
    const todo = todos.addTodo(id, askId, { title: id, check: { pack: 'coding', kind: 'pr_merged', params: {} }, doneWhen: 'Merged', instruction: 'Implement', named: null, approvedAt: at - 2000 }, at - 3000, repo);
    sessions.bind(id, worker(number), at - 2000);
    return todos.updateTodo(todo, { state: 'doing', startedAt: at - 2000 }, at - 2000);
  };
  seed('unique', 1);
  const previous = seed('previous-binding', 1);
  todos.updateTodo(previous, { state: 'done', finishedAt: at - 500 }, at - 500);
  seed('ambiguous-a', 2);
  seed('ambiguous-b', 2);
  seed('other-repository', 3, 'github.com/synthetic/other');
  seed('claimed-producer', 4);
  const claimed = seed('explicit-claim', 5);
  todos.updateTodo(claimed, { state: 'blocked', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url(4)] } } }, at);
  for (const number of [1, 2, 3, 4]) {
    insert.run(number, head, at, at, at);
    await turns.record(worker(number), [{ id: `turn-${number}`, startedAt: at - 1000, endedAt: at + 1000, ended: 'success', inputs: [], urls: [url(number)], finalUrls: [url(number)], complete: true, cursor: '{"seq":1}' }]);
  }
  const beforeOwner = planCodingLedgerTurnOwner({ repo: 'synthetic/owner', number: 1, createdAt: at }, new CodingTurnPrRepository(db).mentions([url(1)]));
  assert.equal(beforeOwner.state, 'unknown');
  evidence.beforeOwner = beforeOwner;
  await ledger.write('assignOwners');
  assert.deepEqual(todos.getTodo('unique')!.check?.params.urls, [url(1)]);
  for (const id of ['ambiguous-a', 'ambiguous-b', 'other-repository', 'claimed-producer'])
    assert.equal(todos.getTodo(id)!.check?.params.urls, undefined, id);
  assert.deepEqual((await events.routeLater({ repo: 'synthetic/owner', number: 1 })).owner, worker(1));
  await ledger.write('assignOwners');
  assert.deepEqual(todos.getTodo('unique')!.check?.params.urls, [url(1)]);
  evidence.todos = ['unique', 'ambiguous-a', 'ambiguous-b', 'other-repository', 'claimed-producer', 'explicit-claim'].map(id => todos.getTodo(id));
  const deliveries: { target: unknown; text: string }[] = [];
  let wakes = 0;
  const delivery = {
    host: 'github.com',
    tell: async (target: unknown, _key: string, text: string) => { deliveries.push({ target, text }); return true; },
    wake: async () => { wakes++; return true; },
  };
  const transition = { repo: 'synthetic/owner', number: 1, title: 'Change', branch: 'work', head, state: 'merged', from: 'waiting_review', closedAt: at + 2000 };
  db.prepare("UPDATE pack_coding_pr_ledger SET state='merged',closed_at=?,terminal_event_json=? WHERE number=1").run(at + 2000, JSON.stringify(transition));
  await deliverCodingPrEvents(events, [], delivery);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].target, worker(1));
  assert(deliveries[0].text.includes('was merged'));
  await ledger.write('daemonMerge', { kind: 'begin', url: url(1), head, actor: 'synthetic-executor', at });
  await ledger.write('daemonMerge', { kind: 'finish', url: url(1), head, commit: merge, at: at + 2000 });
  const spawn: SpawnFn = args => {
    assert(!['merge', 'edit'].includes(args[2]), 'No GitHub mutations permitted');
    let value: unknown;
    if (args[1] === 'pr' && args[2] === 'view') value = { url: url(1), body: '', state: 'MERGED', headRefOid: head, baseRefOid: base, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', author: { login: 'synthetic' }, changedFiles: 0, files: [], labels: [], mergeCommit: { oid: merge } };
    else if (args[2] === 'checks') value = [];
    else if (args.some(arg => arg.endsWith('/reviews'))) value = [[]];
    else if (args.some(arg => arg.endsWith('/labels'))) value = [[]];
    else if (args.some(arg => arg.includes('CodingMergeFiles'))) value = [{ data: { repository: { pullRequest: { headRefOid: head, baseRefOid: base, files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }];
    else value = { data: { repository: { pullRequest: { url: url(1), headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
    return { stdout: new Response(JSON.stringify(value)).body, stderr: new Response('').body, exited: Promise.resolve(0), exitCode: 0, kill() {} };
  };
  await createCodingDaemonMergeSweep(() => db, ledger, events, delivery, spawn)(at + 3000);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[1].target, worker(1));
  assert(deliveries[1].text.includes('Merge confirmed:'));
  assert.equal(wakes, 0);
  evidence.deliveries = deliveries;
  evidence.neoWakes = wakes;
  evidence.owner = await events.routeLater({ repo: 'synthetic/owner', number: 1 });
  console.log(`PASS: one doing coding todo receives its PR URL and ledger owner; ambiguous, other-repository and claimed PRs unchanged; merge event and confirmation target worker; neoWakes=${wakes}; deliveries=${deliveries.length}`);
} finally {
  await app.cleanup();
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/pr-auto-attach.json'), JSON.stringify(evidence, null, 2));
}
