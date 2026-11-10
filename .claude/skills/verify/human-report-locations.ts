import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NeoAskEntry, NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket, readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { workerWorkLocationsBrief } from '../../../packages/daemon/src/lib/work-locations.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const data = join(run, 'home/.hyperneo');
process.env.HYPERNEO_DATA_DIR = data;
const workspace = join(run, 'home/HyperNeo');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db'), workspaceRoot: workspace }), disableWorktrees: true },
  standalone: false,
  verbose: false,
});
const receipts: unknown[] = [];
let socket: WebSocket | undefined;
let front: ReturnType<typeof Bun.serve> | undefined;
async function rpc<T>(name: string, input: unknown): Promise<T> {
  assert(socket);
  const id = crypto.randomUUID();
  const value = await new Promise<T>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`${name} timed out`)), 15_000);
    socket!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if ((reply.requestId ?? reply.id) !== id) return;
      clearTimeout(timeout);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data.value ?? reply.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  receipts.push({ name, input, value });
  return value;
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  await waitForSdkBodyCopy(db);
  assert.notEqual(app.server.port, 8399);
  const owner = `neo:${crypto.randomUUID()}`;
  await app.db.createSession({ id: owner, title: 'Synthetic card owner', workspacePath: workspace, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: {} } as never);
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'synthetic-ask', sessionId: owner, projectId: null, originMessageId: null, title: 'Prepare the travel report', request: 'Prepare a synthetic report', createdAt: Date.now() });
  db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('lsm/hyperneo', 'synthetic-ask');
  assert.equal((db.prepare('SELECT repo FROM neo_asks WHERE id = ?').get('synthetic-ask') as { repo: string }).repo, 'lsm/hyperneo');
  const invoke = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: owner, role: 'neo' }));
  async function add(title: string, params: Record<string, string>) {
    const reply = JSON.parse((await invoke({ name: 'neo.todo.add', input: { askId: 'synthetic-ask', title, named: { repository: 'lsm/hyperneo' }, check: { pack: 'core', kind: 'evidence', params } } })).content[0].text);
    assert(reply.ok && reply.todo, JSON.stringify(reply));
    return reply.todo as NeoTodo;
  }
  const internal = await add('Prepare the human report', {});
  const hidden = join(data, 'work/evidence', internal.id, 'result.md');
  assert.equal(internal.check?.params.path, hidden);
  assert(internal.doneWhen.includes(hidden));
  const report = join(workspace, 'Travel/report.md');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, '# Travel report\n\nA report for the human.');
  const misplaced = JSON.parse((await invoke({ name: 'neo.todo.add', input: { askId: 'synthetic-ask', title: 'Misplaced completion proof', named: { repository: 'lsm/hyperneo' }, check: { pack: 'core', kind: 'evidence', params: { path: report } } } })).content[0].text);
  assert.equal(misplaced.ok, false);
  assert.match(misplaced.reason, /evidence_in_user_folder/);
  store.updateTodo(store.getTodo(internal.id)!, { startedAt: Date.now() }, Date.now());
  const waiting = JSON.parse((await invoke({ name: 'neo.todo.close', input: { todoId: internal.id, reason: 'Waiting for the synthetic file' } })).content[0].text);
  assert.equal(waiting.todo?.state, 'blocked');
  mkdirSync(dirname(hidden), { recursive: true });
  writeFileSync(hidden, 'Internal completion proof');
  const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  await service.todoRunner.checkNow([internal.id], (message, error) => { throw new Error(message, { cause: error }); });
  assert.equal(store.getTodo(internal.id)?.state, 'done');
  const reportText = `Read the human report: ${report}`;
  const reported = JSON.parse((await invoke({ name: 'neo.todo.edit', input: { todoId: internal.id, done: 'reported', evidence: reportText } })).content[0].text);
  assert.equal(reported.ok, true, JSON.stringify(reported));
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('WebSocket failed')); });
  const card = await rpc<{ ok: boolean; entry: NeoAskEntry }>('neo.ask.read', { askId: 'synthetic-ask' });
  assert(card.ok);
  const visible = card.entry.todos.find(todo => todo.id === internal.id)!;
  assert.equal(visible.evidence, null, 'The completed card must not repeat the internal completion proof');
  assert.equal(visible.status, 'Done');
  assert.equal(visible.report, reportText);
  const read = (reference: string) => rpc<{ accepted: boolean; reason?: string }>('file.reference.read', { sourceMessageOrCard: { kind: 'todo', id: internal.id }, reference });
  assert.equal((await read(hidden)).reason, 'forbidden');
  assert.equal((await read(report)).accepted, true);
  assert.equal(store.getTodo(internal.id)?.doneWhen, internal.doneWhen);
  assert.deepEqual(store.getTodo(internal.id)?.check, internal.check);
  assert.equal(store.getTodo(internal.id)?.evidence, `File ${hidden} exists.`);
  const brief = workerWorkLocationsBrief(workspace);
  assert(brief.includes('~/HyperNeo/<matter>/'));
  assert(/never link/i.test(brief));
  writeFileSync(join(run, 'evidence/worker-brief.txt'), brief);
  const browserAt = process.argv.indexOf('--browser');
  if (browserAt >= 0) {
    const control = resolve(process.argv[browserAt + 1]);
    const dist = resolve('packages/web/dist');
    front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
      const route = new URL(request.url).pathname;
      if (route === '/proof-entry') return new Response(null, { status: 302, headers: { location: '/neo', 'set-cookie': `hyperneo_device=${readLocalCredential()}; HttpOnly; SameSite=Strict; Path=/` } });
      if (route === '/ws') {
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      const file = Bun.file(join(dist, route === '/neo' ? 'neo/index.html' : route));
      return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
    }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'browser.json'), JSON.stringify({ url: `http://127.0.0.1:${front.port}/proof-entry`, internalId: internal.id, hidden, report, evidence: join(run, 'evidence'), doneFile: join(control, 'done') }));
    const deadline = Date.now() + 15 * 60_000;
    while (!existsSync(join(control, 'done')) && Date.now() < deadline) await Bun.sleep(250);
    assert(existsSync(join(control, 'done')));
    assert.equal(JSON.parse(readFileSync(join(run, 'evidence/browser.json'), 'utf8')).passed, true);
  }
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ passed: true, card: card.entry, rawCompletionRetained: true, generatedProofHidden: true, reportPreserved: true, userFolderCheckRefused: true, hiddenReadForbidden: true, reportReadable: true, completionCheckPassed: true }, null, 2));
} finally {
  socket?.close();
  await front?.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(receipts, null, 2));
}
