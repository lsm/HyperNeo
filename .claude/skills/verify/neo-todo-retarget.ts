process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createNeoOperations, createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const root = 'neo:00000000-0000-4000-8000-000000000004';
let oldId = '';
let nextId = '';
let starts = 0;
const evidence: unknown[] = [];
for (const phase of ['request', 'recovery']) {
  const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true }, verbose: false });
  let service: ReturnType<typeof createNeoService> | undefined;
  try {
    await app.spaceRuntimeService.ready();
    await app.jobProcessor.stop();
    assert.notEqual(app.server.port, 8399);
    service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
    const db = app.db.getDatabase();
    const { todos, todoSessions } = service;
    const production = app.sessionManager.getOperationRegistry();
    const retarget = createNeoOperations(service).find((op) => op.name === 'neo.todo.retarget')!;
    const registry = createOperationRegistry(production.entries.map((op) => op.name === retarget.name ? retarget : op.name === 'work.start' ? { ...op, execute: async (input) => {
      starts++;
      evidence.push({ phase, admittedStart: input });
      return { ok: true, value: { ref: { adapter: 'hyperneo', id: nextId }, title: 'Replacement', place: { machine: 'synthetic', name: 'workspace', folder: join(run, 'workspace') }, status: 'queued', lastActivityAt: Date.now(), receipt: { executionId: nextId, inputId: 'replacement' } } };
    } } : op));
    app.sessionManager.setOperationRegistryProvider(() => registry);
    const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: root, role: 'neo' }));
    if (phase === 'request') {
      for (const title of ['held', 'replacement']) {
        const id = await app.sessionManager.createSession({ title, workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' } });
        if (title === 'held') oldId = id; else nextId = id;
      }
      db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Neo',?,'2026-11-16','2026-11-16','active','{}','{}')").run(root, join(run, 'workspace'));
      service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
      todos.openAsk({ id: 'ask', sessionId: root, projectId: null, originMessageId: null, title: 'Core move', request: 'Continue in the stored place', createdAt: 1 });
      const target = { verb: 'start' as const, adapter: 'hyperneo', model: 'stored-model', place: { machine: 'synthetic', name: 'workspace', folder: join(run, 'workspace') } };
      for (const id of ['requested', 'interrupted']) {
        const todo = todos.addTodo(id, 'ask', { title: id, doneWhen: 'Done', instruction: 'Continue the synthetic work', check: null, named: null, approvedAt: 1 }, 1);
        todoSessions.create(id, target);
        todoSessions.recordRef(id, { adapter: 'hyperneo', id: oldId }, 1);
        todos.updateTodo(todo, { state: 'doing', startedAt: 1 }, 1);
      }
      db.prepare("UPDATE neo_todo_sessions SET ref = NULL WHERE todo_id = 'interrupted'").run();
      const live = await app.sessionManager.getSessionForControl(oldId);
      assert(live);
      await live.stateManager.setProcessing('ordinary-input');
      const queued = ['ordinary-first', 'ordinary-later'].map((messageUuid) => app.jobQueue.enqueue({ queue: 'message_delivery', payload: { sessionId: oldId, messageUuid }, runAt: Date.now() + 7_200_000 }));
      const queuedRows = () => db.prepare("SELECT id,status,payload,run_at FROM job_queue WHERE id IN (?,?) ORDER BY id").all(queued[0]!.id, queued[1]!.id);
      const beforeQueued = queuedRows();
      const ordinaryStop = await handler({ name: 'work.stop', input: { ref: { adapter: 'hyperneo', id: oldId } } });
      assert.deepEqual(JSON.parse(ordinaryStop.content[0]!.text), { ok: true, value: { stopped: true } });
      evidence.push({ phase, ordinaryStop: ordinaryStop.content, beforeQueued, afterQueued: queuedRows() });
      assert.deepEqual(queuedRows(), beforeQueued, 'an ordinary stop must leave queued delivery jobs untouched');
      db.prepare('DELETE FROM job_queue WHERE id IN (?,?)').run(queued[0]!.id, queued[1]!.id);
      await live.stateManager.setRateLimitCooldown({ reason: 'limit', since: 1, retryAt: Date.now() + 7_200_000, retryCount: 0, maxRetries: 0, heldPrompt: { uuid: 'held-input', content: 'Must never resume' } });
      let reopenedNotified = false;
      const onTodoChange = () => { if (todos.getTodo('requested')?.state === 'todo' && todoSessions.readRef('requested') === null) reopenedNotified = true; };
      app.reactiveDb.on('change:neo_todos', onTodoChange);
      const result = await handler({ name: 'neo.todo.retarget', input: { todoId: 'requested', fromRef: { adapter: 'hyperneo', id: oldId } } });
      app.reactiveDb.off('change:neo_todos', onTodoChange);
      assert.equal(reopenedNotified, true, 'the board must receive the reopened todo before its next start');
      evidence.push({ phase, reopenedNotified });
      evidence.push({ phase, result: result.content });
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      assert.equal(JSON.parse(result.content[0]!.text).ok, true, JSON.stringify(result));
      assert.equal(starts, 1);
      assert.deepEqual(todoSessions.get('requested'), target);
      assert.deepEqual(todoSessions.readRef('requested'), { adapter: 'hyperneo', id: nextId });
      assert.notEqual(live.getProcessingState().status, 'rate_limit_cooldown');
      const saved = JSON.parse(app.db.getSession(oldId)!.processingState!);
      assert.equal(saved.heldPrompt, undefined);
      assert.equal(saved.status === 'rate_limit_cooldown', false);
      evidence.push({ phase, clearedState: saved, storedTarget: todoSessions.get('requested') });
      db.prepare("UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = 'interrupted'").run(JSON.stringify({ adapter: 'hyperneo', id: oldId }));
      db.prepare("INSERT INTO pack_facts (todo_id,pack,key,value_json) VALUES ('interrupted','core','move',?)").run(JSON.stringify({ fromRef: { adapter: 'hyperneo', id: oldId }, at: Date.now() - 7_200_000 }));
      await live.stateManager.setRateLimitCooldown({ reason: 'limit', since: 1, retryAt: Date.now() + 7_200_000, retryCount: 0, maxRetries: 0, heldPrompt: { uuid: 'recovery-input', content: 'Recover without replaying this prompt' } });
    } else {
      await service.sweepPacks();
      await service.sweepPacks();
      evidence.push({ phase, recovering: todos.getTodo('interrupted'), pending: db.prepare("SELECT value_json FROM pack_facts WHERE key = 'move'").all(), old: app.db.getSession(oldId)?.processingState });
      assert.equal(starts, 2, 'one request plus one recovered move, never two recovery starts');
      assert.deepEqual(todoSessions.readRef('interrupted'), { adapter: 'hyperneo', id: nextId });
      assert.deepEqual(todoSessions.get('interrupted'), todoSessions.get('requested'));
      assert.equal(JSON.parse(app.db.getSession(oldId)!.processingState!).heldPrompt, undefined);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pack_facts WHERE pack = 'core' AND key = 'move'").get()?.n, 0);
      const read = await handler({ name: 'neo.todo.read', input: { todoId: 'interrupted' } });
      assert.equal(read.isError ?? false, false, JSON.stringify(read));
      evidence.push({ phase, publicRead: read.content, target: todoSessions.get('interrupted'), starts });
      const peer = await app.sessionManager.getSessionForControl(oldId);
      assert(peer);
      await peer.stateManager.setRateLimitCooldown({ reason: 'limit', since: 1, retryAt: Date.now() + 7_200_000, retryCount: 0, maxRetries: 0, heldPrompt: { uuid: 'peer-input', content: 'Keep this peer work' } });
      const sent = todos.addTodo('sent-peer', 'ask', { title: 'Peer work', doneWhen: 'Done', instruction: 'Message the peer', check: null, named: null, approvedAt: 1 }, 1);
      todoSessions.create(sent.id, { verb: 'send', ref: { adapter: 'hyperneo', id: oldId } });
      todoSessions.recordRef(sent.id, { adapter: 'hyperneo', id: oldId }, 1);
      todos.updateTodo(sent, { state: 'doing', startedAt: 1 }, 1);
      const beforePeer = app.db.getSession(oldId)!.processingState;
      const refused = await handler({ name: 'neo.todo.retarget', input: { todoId: sent.id, fromRef: { adapter: 'hyperneo', id: oldId } } });
      assert.equal(JSON.parse(refused.content[0]!.text).ok, false, JSON.stringify(refused));
      assert.equal(todos.getTodo(sent.id)?.state, 'doing');
      assert.equal(app.db.getSession(oldId)!.processingState, beforePeer);
      assert.equal(starts, 2);
      evidence.push({ phase, sentPeerRefused: refused.content, peerUnchanged: true });
      for (const mode of ['adopted', 'unsupported']) {
        const todo = todos.addTodo(mode, 'ask', { title: mode, doneWhen: 'Removed', instruction: 'Synthetic work', check: null, named: null, approvedAt: 1 }, 1);
        if (mode === 'adopted') todoSessions.bind(mode, { adapter: 'hyperneo', id: oldId }, 1);
        else {
          const ref = { adapter: 'claude-code', id: 'synthetic-unsupported' };
          todoSessions.create(mode, { verb: 'send', ref });
          todoSessions.recordRef(mode, ref, 1);
        }
        todos.updateTodo(todo, { state: 'doing', startedAt: 1 }, 1);
        const removed = await handler({ name: 'neo.todo.remove', input: { todoId: mode, reason: 'Synthetic removal' } });
        assert.equal(removed.isError ?? false, false, JSON.stringify(removed));
        assert.equal(JSON.parse(removed.content[0]!.text).ok, true, JSON.stringify(removed));
        assert.equal(todos.getTodo(mode)?.state, 'removed');
        evidence.push({ phase, ordinaryRemoval: mode, result: removed.content });
      }
    }
  } finally {
    await service?.dispose();
    await app.cleanup();
    writeFileSync(join(run, 'evidence/retarget.json'), JSON.stringify(evidence, null, 2));
  }
}
console.log(`PASS starts=${starts}, removals=2, queuedDeliveries=2, reopenedNotified=true, peerUntouched=true: ordinary stops preserve queued input and retarget publishes the reopened todo.`);
