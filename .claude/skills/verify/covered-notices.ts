process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const directory of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, directory), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1',
  dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert(![8399, 8499].includes(app.server.port));
await app.spaceRuntimeService.ready();
await app.jobProcessor.stop();
await waitForSdkBodyCopy(app.db.getDatabase());
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
const root = 'neo:10000000-0000-4000-8000-000000001036';
const ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`, join(run, 'data/local-rpc.credential'));
const evidence: Record<string, unknown> = { passed: false, port: app.server.port, reports: [], reminders: [] };
const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 10000);
  ws.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    clearTimeout(timer);
    reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data);
  };
  ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
    data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const seedSession = (id: string) => app.db.createSession({ id, title: 'Synthetic covered notice',
  workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0,
    inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
const entries = () => (app.db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue='mailbox'")
  .all() as { payload: string }[]).map((row) => JSON.parse(row.payload));
const reports = (id: string) => entries().filter((entry) => {
  const text = entry.message.message.content;
  return typeof text === 'string' && text.startsWith('Worker turn report') && text.includes(`todo ${id},`);
});
const question = (askId: string, todoId: string) => service.todos.askQuestion(crypto.randomUUID(), askId,
  { text: 'Choose the next action', kind: 'reply', options: null, multiple: false,
    noLabel: null, yesLabel: null, startTodos: null, todoId }, Date.now());
const realNow = Date.now;
try {
  await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('RPC unavailable')); });
  await seedSession(root);
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const scenario of ['covered', 'closed', 'changed', 'new-card', 'meaningful', 'send-only', 'environment-reblocked']) {
    const id = `report-${scenario}`, at = Date.now(), ref = { adapter: 'hyperneo', id };
    await seedSession(id);
    service.todos.openAsk({ id, sessionId: root, title: id, request: 'Observe notices',
      projectId: null, originMessageId: null, createdAt: at });
    const todo = service.todos.addTodo(id, id, { title: id, instruction: 'Synthetic work',
      doneWhen: 'Evidence exists', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing') } }, named: null }, at);
    service.todoSessions.create(id, { verb: 'send', ref });
    service.todoSessions.recordRef(id, ref, at);
    service.todos.updateTodo(todo, { state: 'doing', startedAt: at }, at);
    const inputId = `${id}-input`;
    service.todoSessions.recordSent(id, { inputBefore: at, opening: 'Synthetic work', receipt: { executionId: id, inputId } });
    const dispatch = await service.todoSessions.inputs.accept(id, root, { verb: 'send', ref }, 'Synthetic work', at);
    await service.todoSessions.inputs.recordOutcome(dispatch, { ref, receipt: { executionId: id, inputId },
      delivery: { delivered: true, receipt: { executionId: id, inputId } } }, at);
    await app.db.saveUserMessage(id, { type: 'user', uuid: inputId, session_id: id,
      parent_tool_use_id: null, message: { role: 'user', content: 'Synthetic work' } } as SDKMessage, 'consumed');
    const card = scenario === 'send-only' ? null : question(id, id);
    const result = async (text: string) => {
      await new Promise((done) => setTimeout(done, 5));
      await app.db.saveSDKMessage(id, { type: 'result', subtype: 'success', uuid: crypto.randomUUID(),
        parent_tool_use_id: null, is_error: false, result: text } as SDKMessage);
      const status = await rpc('work.status', { ref, since: at });
      const detail = status as { ok: boolean; value: { turnEnds?: { message: string }[] } };
      assert(detail.ok && detail.value.turnEnds?.some((turn) => turn.message === text));
      await service.refreshDriverWork();
    };
    const kind = scenario === 'environment-reblocked' ? 'environment' : 'needs_human';
    await result(`Blocked (${kind}): Approval required`);
    assert.equal(reports(id).length, 1, `${scenario} first notice`);
    if (scenario === 'closed' || scenario === 'new-card') service.todos.retireQuestion(card!, 'Resolved', null, Date.now());
    if (scenario === 'new-card') question(id, id);
    if (scenario === 'closed' || scenario === 'environment-reblocked') {
      service.todos.updateTodo(service.todos.getTodo(id)!, { state: 'doing' }, Date.now());
      assert.equal(service.todos.getTodo(id)?.state, 'doing');
    }
    const text = scenario === 'changed' ? 'Blocked (needs_human): Another decision\r\n'
      : scenario === 'meaningful' ? 'New evidence.\nBlocked (needs_human): Approval required\r\n'
      : `Blocked (${kind}): Approval required\r\n`;
    await result(text);
    const count = reports(id).length;
    assert.equal(count, scenario === 'covered' ? 1 : 2, `${scenario} repeat`);
    (evidence.reports as unknown[]).push({ scenario, count });
  }
  const hour = 3600000;
  let clock = realNow();
  Date.now = () => clock;
  for (const scenario of ['covered', 'closed', 'changed', 'unrelated', 'failed']) {
    const id = `reminder-${scenario}`;
    service.todos.openAsk({ id, sessionId: root, title: id, request: 'Observe reminder',
      projectId: null, originMessageId: null, createdAt: clock });
    service.todos.addTodo(id, id, { title: id, instruction: null, doneWhen: 'Observed', check: null, named: null }, clock);
    service.todos.commitState(id, { state: 'blocked', blockedBy: 'stalled', blockedReason: 'No progress' }, clock, { state: 'no_opinion' });
    if (scenario === 'unrelated') {
      service.todos.addTodo(`${id}-other`, id, { title: 'Other work', instruction: null,
        doneWhen: 'Observed', check: null, named: null }, clock);
      service.todos.commitState(`${id}-other`, { state: 'doing' }, clock, { state: 'no_opinion' });
    }
    const card = question(id, scenario === 'unrelated' ? `${id}-other` : id);
    const reminders = () => entries().filter((entry) => entry.message.message.content.includes(`(${id})`));
    clock += 2 * hour;
    await service.refreshDriverWork();
    assert.equal(reminders().length, 1, `${scenario} first reminder`);
    const entry = reminders()[0];
    const dbId = await app.db.saveUserMessage(root, { ...entry.message, uuid: entry.messageUuid,
      session_id: root, message: { role: 'user', content: entry.message.message.content } }, scenario === 'failed' ? 'failed' : 'consumed');
    await app.db.getSDKMessageRepo().write('updateMessageTimestamp', dbId, clock);
    const receipt = await rpc('message.status', { sessionId: root, messageId: entry.messageUuid });
    assert(JSON.stringify(receipt).includes(scenario === 'failed' ? 'failed' : 'delivered'));
    await service.refreshDriverWork();
    if (scenario === 'closed') service.todos.retireQuestion(card, 'Resolved', null, clock);
    if (scenario === 'changed') {
      clock++;
      service.todos.commitState(id, { blockedReason: 'Another blocker' }, clock, { state: 'no_opinion' });
    }
    clock += 2 * hour;
    await service.refreshDriverWork();
    const count = reminders().length;
    assert.equal(count, scenario === 'covered' ? 1 : 2, `${scenario} repeat reminder`);
    (evidence.reminders as unknown[]).push({ scenario, count, receipt });
  }
  evidence.passed = true;
  console.log('PASS: 7 report cases and 5 reminder cases observed through RPC and real mailbox admission');
} finally {
  Date.now = realNow;
  ws.close();
  await service.dispose();
  await app.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/covered-notices.json'), JSON.stringify(evidence, null, 2));
}
