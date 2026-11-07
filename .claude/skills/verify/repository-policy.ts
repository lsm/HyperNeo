import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { neoStartPlace } from '../../../packages/daemon/src/lib/neo/start-place.ts';
import { neoTodoRepository } from '../../../packages/daemon/src/lib/neo/pack-contract.ts';
import { neoTodoPolicies } from '../../../packages/daemon/src/lib/neo/packs/todo-policies.ts';
import { createArtifactReferenceResolve } from '../../../packages/daemon/src/lib/artifacts/resolve-operation.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), verbose: false });
const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
const root = 'neo:10000000-0000-4000-8000-000000000004';
const observed: Record<string, unknown> = { receipts: [], surface: 'Actual daemon MCP admission and artifact RPC, real start-place pipeline; scripted adapter start and PR-summary network boundaries' };
let starts = 0;
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ createSocket: createLocalSocket, url: `ws://127.0.0.1:${app.server.port}/ws` });
hub.registerTransport(transport);
try {
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.db.createSession({ id: root, title: 'Synthetic repository policy', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const start = createWorkVerbOperations({
    daemonName: 'synthetic',
    adapters: () => [{ id: 'synthetic', capabilities: ['start'], find: () => [], start: async (input) => {
      starts++;
      return { ok: true, value: { ref: { adapter: 'synthetic', id: `worker-${starts}` }, title: input.title, place: input.place, status: 'running', lastActivityAt: Date.now() } };
    } }],
    remote: { list: () => [], invoke: async () => { throw new Error('No remote calls'); } },
    isOpenTodo: (id, owner) => store.getTodo(id)?.askId === 'policy' && owner === root,
    startPlace: neoStartPlace({ db, machine: 'synthetic', workspaceRoot: join(run, 'workspace'), repository: (todo, ask) => neoTodoRepository(todo ?? { check: null, named: null }, neoTodoPolicies(db), { ask, todo, start: true }) }),
  }).find((op) => op.name === 'work.start')!;
  const reference = createArtifactReferenceResolve(() => db, join(run, 'data'), join(run, 'home'), async (target) => ({ url: `https://${target.repository}/pull/${target.number}`, repository: target.repository, number: target.number, title: 'Synthetic PR', body: '', state: 'OPEN', headSha: 'a'.repeat(40), checks: 'passing', review: 'approved', changedFiles: 0, files: [], filesTruncated: false }));
  const original = app.sessionManager.getOperationRegistry();
  const registry = createOperationRegistry(original.entries.map((op) => op.name === start.name ? start : op.name === reference.name ? reference : op));
  app.sessionManager.setOperationRegistryProvider(() => registry);
  const mcp = createOperationMcpHandler(registry, () => ({ sessionId: root, role: 'neo' }));
  const call = async (name: string, input: unknown, expected = true) => {
    const reply = await mcp({ name, input });
    assert(!reply.isError, JSON.stringify(reply));
    const result = JSON.parse(reply.content[0].text);
    (observed.receipts as unknown[]).push({ name, input, result });
    assert.equal(result.ok, expected, JSON.stringify(result));
    return result;
  };
  store.openAsk({ id: 'policy', title: 'Repository policy', request: 'Preserve placement', sessionId: root, projectId: null, originMessageId: null, repo: 'github.com/synthetic/ask', createdAt: 1 });
  const check = { pack: 'core', kind: 'evidence', params: {} };
  store.addTodo('repository-context','policy',{title:'Known repository',doneWhen:'Observed',check:null,instruction:null,named:null},1,'github.com/synthetic/ask');
  const target = { verb: 'start', adapter: 'hyperneo' };
  for (const rule of [check, { pack: 'coding', kind: 'pr_merged', params: { urls: [] } }]) {
    const refused = await call('neo.todo.add', { askId: 'policy', title: 'Missing place', check: rule, instruction: 'Work', target }, false);
    assert(refused.reason.startsWith('place_required:'));
    assert.equal(store.listTodos('policy').length, 1);
  }
  const bad = await call('neo.todo.add', { askId: 'policy', title: 'Invalid check', check: { pack: 'core', kind: 'unknown', params: {} }, instruction: 'Work', target }, false);
  assert(bad.reason.startsWith('check_refused:'));
  const added = await call('neo.todo.add', { askId: 'policy', title: 'Stored work', check });
  const id = added.todo.id, before = store.getTodo(id);
  for (const edit of [{}, { check: { pack: 'core', kind: 'unknown', params: {} } }]) {
    const refused = await call('neo.todo.edit', { todoId: id, instruction: 'Work', target, ...edit }, false);
    assert(refused.reason.startsWith('place_required:'));
    assert.deepEqual(store.getTodo(id), before);
    assert.equal(sessions.get(id), null);
  }
  observed.admissionPreserved = true;
  store.openAsk({ id: 'ask-only', title: 'Historical association', request: 'Keep stored fallback', sessionId: root, projectId: null, originMessageId: null, repo: 'github.com/synthetic/history', createdAt: 1 });
  const fresh = await call('neo.todo.add', { askId: 'ask-only', title: 'Fresh non-repository work', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'workspace', 'fresh.md') } } });
  assert.equal(fresh.todo.repo, null);
  const old = store.addTodo('ask-only-stored', 'ask-only', { title: 'Stored ask-only work', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1);
  const denied = await call('neo.todo.edit', { todoId: old.id, check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'workspace', 'misplaced.md') } } }, false);
  assert(denied.reason.startsWith('evidence_in_user_folder:'));
  assert.deepEqual(store.getTodo(old.id), old);
  observed.newDraftAndStoredEvidenceScopesPreserved = true;
  await transport.connect();
  const urls = ['stored', 'ask', 'check'].map((name) => `https://github.com/synthetic/${name}/pull/1`);
  db.prepare('UPDATE neo_todos SET report = ?, check_json = ?, named = ? WHERE id = ?').run(urls.join('\n'), JSON.stringify({ pack: 'coding', kind: 'pr_merged', params: { urls: [urls[2]] } }), JSON.stringify({ repository: 'synthetic/named' }), id);
  db.prepare('UPDATE pack_coding_todos SET repo=? WHERE todo_id=?').run('github.com/synthetic/stored',id);
  const resolveReference = (reference: string) => hub.request<{ accepted: boolean; pr?: { repository: string } }>('operation.invoke', { name: 'artifact.reference.resolve', input: { sourceMessageOrCard: { kind: 'todo', id }, reference, requestId: crypto.randomUUID() } });
  const stored = await resolveReference(urls[0]);
  assert(stored.accepted && stored.pr?.repository === 'github.com/synthetic/stored', JSON.stringify(stored));
  assert(!(await resolveReference(urls[1])).accepted);
  assert(!(await resolveReference(urls[2])).accepted);
  db.prepare('UPDATE pack_coding_todos SET repo = NULL WHERE todo_id = ?').run(id);
  const inherited = await resolveReference(urls[1]);
  assert(inherited.accepted && inherited.pr?.repository === 'github.com/synthetic/ask');
  db.prepare("UPDATE pack_coding_todos SET repo = '' WHERE todo_id = ?").run(id);
  assert(!(await resolveReference(urls[1])).accepted);
  observed.artifactStoredPrecedence = true;
  for (const repo of ['github.com/synthetic/stored', null, '']) {
    db.prepare('UPDATE pack_coding_todos SET repo = ? WHERE todo_id = ?').run(repo, id);
    const refusal = await call('work.start', { todoId: id, adapter: 'synthetic', title: 'Work', message: 'Work' }, false);
    assert.equal(refusal.reason, 'invalid_place');
    assert.equal(starts, 0);
  }
  db.prepare('UPDATE neo_asks SET repo = NULL WHERE id = ?').run('policy');
  db.prepare('UPDATE pack_coding_todos SET repo = NULL WHERE todo_id = ?').run(id);
  const local = await call('work.start', { todoId: id, adapter: 'synthetic', title: 'Work', message: 'Work' });
  assert.equal(local.value.place.folder, join(run, 'workspace'));
  assert.equal(starts, 1);
  observed.startStoredPrecedence = true;
  observed.verified = true;
} finally {
  await transport.close();
  hub.cleanup();
  await app.cleanup();
  observed.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/repository-policy.json'), JSON.stringify(observed, null, 2));
}
