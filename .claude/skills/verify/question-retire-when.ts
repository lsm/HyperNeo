import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoService } from '../../../packages/daemon/src/lib/neo/service.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), `external HTTP refused: ${url.hostname}`);
  return nativeFetch(input, init);
}) as typeof fetch;
let service: NeoService | undefined;
const recover = NeoService.prototype.recover;
NeoService.prototype.recover = async function () {
  service = this;
  return recover.call(this);
};
const owner = 'neo:10000000-0000-4000-8000-000000009400';
const receipts: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
type Receipt = { entry?: { state: string; todos: NeoTodo[]; questions: NeoQuestion[] }; ok?: boolean; reason?: string; question?: NeoQuestion; todos?: NeoTodo[]; error?: unknown };
async function rpc(name: string, input: unknown): Promise<Receipt> {
  assert(ws);
  const id = crypto.randomUUID();
  const result = await new Promise<Receipt>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`${name} timed out`)), 15000);
    ws!.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id && message.requestId !== id) return;
      clearTimeout(timeout);
      done(message.error ? { error: message.error } : message.data.value ?? message.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  receipts.push({ name, input, result });
  return result;
}
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert(app.server.port > 0 && app.server.port !== 8399);
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  assert(service);
  app.db.updateGlobalSettings({ neo: { packs: ['life-admin'] } });
  await app.db.createSession({ id: owner, title: 'Synthetic fact check', workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  store.openAsk({ id: 'ask', sessionId: owner, projectId: null, originMessageId: null, title: 'Stale facts', request: 'Let facts retire a card', createdAt: Date.now() });
  const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'facts.txt') } };
  const previous = store.addTodo('previous', 'ask', { title: 'Previous worker task', doneWhen: 'Reported', check, instruction: null, named: null }, 1);
  store.updateTodo(previous, { state: 'done' }, 2);
  const waiting = store.addTodo('waiting', 'ask', { title: 'Continue after the obsolete question', doneWhen: 'Observed', check: { ...check, params: { path: join(run, 'later.txt') } }, instruction: null, named: null }, 3);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket open failed')); });
  const invalid = await rpc('neo.question.ask', { askId: 'ask', kind: 'reply', text: 'Missing retirement condition' });
  assert.notEqual(invalid.ok, true);
  assert.match(JSON.stringify(invalid), /retireWhen is required without a linked todo/);
  for (const retireWhen of [
    { pack: 'missing-pack', kind: 'evidence', params: { path: join(run, 'facts.txt') } },
    { pack: 'core', kind: 'evience', params: { path: join(run, 'facts.txt') } },
    { pack: 'core', kind: 'evidence', params: { path: 'relative-facts' } },
  ]) {
    const refused = await rpc('neo.question.ask', { askId: 'ask', kind: 'reply', text: 'Invalid predicate', retireWhen });
    assert.equal(refused.ok, false);
    assert.match(refused.reason!, /^check_(required|refused|unsupported):/);
  }
  assert.equal(store.listQuestions('ask').length, 0);
  const uncheckedTodo = store.addTodo('legacy-unchecked', 'ask', { title: 'Legacy unchecked work', doneWhen: 'Old condition', check: null, instruction: null, named: null }, 3);
  const unchecked = await rpc('neo.question.ask', { askId: 'ask', todoId: uncheckedTodo.id, kind: 'reply', text: 'Legacy linked card' });
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.reason!, /retire_when_required/);
  const staleLink = await rpc('neo.question.ask', { askId: 'ask', todoId: previous.id, kind: 'reply', text: 'Old worker question' });
  assert.equal(staleLink.ok, false);
  assert.match(staleLink.reason!, /retire_when_required/);
  const created = await rpc('neo.question.ask', { askId: 'ask', todoId: previous.id, kind: 'reply', text: 'The prerequisite is unavailable', retireWhen: check });
  assert(created.ok && created.question, JSON.stringify(created));
  assert(!created.question.todoId);
  assert.deepEqual(created.question.retireWhen, check);
  store.updateTodo(waiting, { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Waiting on the question' }, Date.now());
  await service.sweepPacks();
  const before = await rpc('neo.question.get', { questionId: created.question.id });
  assert.equal(before.question?.state, 'open');
  const beforeCard = await rpc('neo.ask.read', { askId: 'ask' });
  assert.equal(beforeCard.entry?.state, 'waiting');
  assert.equal(beforeCard.entry.todos.find(todo => todo.id === waiting.id)?.blockedBy, 'needs-human');
  assert.equal(store.getTodo(waiting.id)?.blockedBy, 'needs-human');
  writeFileSync(check.params.path, 'The prerequisite is already available.');
  await service.sweepPacks();
  const after = await rpc('neo.question.get', { questionId: created.question.id });
  assert.equal(after.question?.state, 'retired');
  assert.equal(after.question?.retiredReason, `File ${check.params.path} exists.`);
  assert.equal(after.question?.answer, null);
  const afterCard = await rpc('neo.ask.read', { askId: 'ask' });
  assert.equal(afterCard.entry?.state, 'todo');
  assert.equal(afterCard.entry.todos.find(todo => todo.id === waiting.id)?.blockedBy, null);
  assert.equal(afterCard.entry.questions.find(question => question.id === created.question!.id)?.state, 'retired');
  assert.equal(store.getTodo(waiting.id)?.blockedBy, null);
  assert.equal(store.getTodo(waiting.id)?.state, 'todo');
  const notices = () => app!.db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': owner, messageUuid: `neo-question-retired:${created.question!.id}` });
  assert.equal(notices().length, 1);
  const line = (notices()[0].payload as { message: { message: { content: string } } }).message.message.content;
  assert(!line.includes('\n'));
  assert(line.startsWith(`Retired question ${created.question.id}: `));
  await service.sweepPacks();
  assert.equal(notices().length, 1);
  const retry = await rpc('neo.question.ask', { askId: 'ask', kind: 'reply', text: 'Notice must survive enqueue failure', retireWhen: check });
  assert(retry.ok && retry.question);
  store.updateTodo(waiting, { state: 'blocked', blockedBy: 'needs-human' }, Date.now());
  db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' BEGIN SELECT RAISE(ABORT, 'notice enqueue failed'); END");
  await service.sweepPacks();
  const failedEnqueue = await rpc('neo.question.get', { questionId: retry.question.id });
  assert.equal(failedEnqueue.question?.state, 'open');
  assert.equal(store.getTodo(waiting.id)?.blockedBy, 'needs-human');
  const retryNotices = () => app!.db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': owner, messageUuid: `neo-question-retired:${retry.question!.id}` });
  assert.equal(retryNotices().length, 0);
  db.exec('DROP TRIGGER fail_notice');
  await service.sweepPacks();
  const recoveredEnqueue = await rpc('neo.question.get', { questionId: retry.question.id });
  assert.equal(recoveredEnqueue.question?.state, 'retired');
  assert.equal(store.getTodo(waiting.id)?.blockedBy, null);
  assert.equal(retryNotices().length, 1);
  await service.sweepPacks();
  assert.equal(retryNotices().length, 1);
  receipts.push({ failedEnqueue, recoveredEnqueue, retriedNotice: retryNotices()[0].payload });
  receipts.push({ beforeCard, afterCard, releasedTodo: store.getTodo(waiting.id), neoNotice: notices()[0].payload, isolatedPort: app.server.port });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ passed: true, receipts, limits: 'Real isolated daemon, pack sweep and WebSocket operation receipts. No browser layout, provider, model or live database.' }, null, 2));
  console.log('PASS: the real operation door rejects unchecked unlinked cards; unmet facts keep the hold; passed facts atomically retire with evidence, release the hold and enqueue one Neo line; enqueue failure rolls back and a later sweep recovers.');
} finally {
  ws?.close();
  await app?.cleanup();
  NeoService.prototype.recover = recover;
  globalThis.fetch = nativeFetch;
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(receipts, null, 2));
}
