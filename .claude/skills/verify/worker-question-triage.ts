import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { ProviderService } from '../../../packages/daemon/src/lib/provider-service.ts';
import { sessionDoorPath } from '../../../packages/daemon/src/lib/messaging/session-door.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const directory of ['evidence', 'bin', 'workspace']) mkdirSync(join(run, directory), { recursive: true });
for (const command of ['gh', 'ps', 'open']) writeFileSync(join(run, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const rule = 'Use staging for previews.';
let questionToResolve: string | undefined;
let issued = false;
let phase = 'initial';
let requests = 0;
const neoBodies: { phase: string; body: string }[] = [];
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const body = await request.json();
  writeFileSync(join(run, `evidence/model-${++requests}.json`), JSON.stringify({ phase, body }, null, 2));
  const neo = JSON.stringify(body.system).includes('You are Neo, the human');
  if (neo) neoBodies.push({ phase, body: JSON.stringify(body) });
  const invoke = neo && questionToResolve && !issued && body.tools?.some((tool: { name: string }) => tool.name === 'mcp__hyperneo-operations__invoke');
  if (invoke) issued = true;
  const events = [
    ['message_start', { type: 'message_start', message: { id: `msg_${requests}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: invoke ? { type: 'tool_use', id: `toolu_resolution_${requests}`, name: 'mcp__hyperneo-operations__invoke', input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: invoke ? { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'neo.question.resolve', input: { questionId: questionToResolve, answer: ['Staging'], source: { kind: 'rule', text: rule } } }) } : { type: 'text_delta', text: 'Synthetic triage completed.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const build = QueryOptionsBuilder.prototype.build;
const sessionEnv = ProviderService.prototype.resolveSessionProviderEnvVars;
const modelEnv = ProviderService.prototype.getEnvVarsForModel;
ProviderService.prototype.resolveSessionProviderEnvVars = async function (...args) { return { ...await sessionEnv.apply(this, args), ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }; };
ProviderService.prototype.getEnvVarsForModel = async function (...args) { return { ...await modelEnv.apply(this, args), ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` }; };
QueryOptionsBuilder.prototype.build = async function (...args) { return { ...await build.apply(this, args), sandbox: { enabled: false } }; };
const config = { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
const receipts: unknown[] = [];
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: String(app!.server.port) }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  receipts.push({ name, input, result }); writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(receipts, null, 2));
  assert.equal(await child.exited, 0); assert(!result.reply.error, JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
async function workerSend(input: unknown) {
  const result = await new Promise<{ kind: string; value?: { kind: string } }>((done, fail) => {
    const call = request({ socketPath: sessionDoorPath(), path: '/', method: 'POST', agent: false, headers: { 'content-type': 'application/json', connection: 'close' } }, (response) => {
      let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => { try { done(JSON.parse(body)); } catch (error) { fail(error); } });
    });
    call.on('error', fail); call.end(JSON.stringify({ sender: 'synthetic-worker', name: 'message.send', input }));
  });
  receipts.push({ name: 'session-door:message.send', result });
  assert.equal(result.kind, 'completed'); assert.equal(result.value?.kind, 'accepted');
}
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 45000;
  while (!(await check()) && Date.now() < end) await Bun.sleep(100);
  assert(await check(), message);
}
try {
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  const { servers } = await rpc('rpc:mcp.registry.list', {});
  for (const server of servers) await rpc('rpc:mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const root = (await rpc('neo.open', {})).sessionId;
  await rpc('neo.rule.save', { add: [rule] });
  await app.db.createSession({ id: 'synthetic-worker', title: 'Synthetic worker', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'claude-sonnet-4-6', provider: 'anthropic', maxTokens: 8192 }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  let store = new NeoAskTodoRepository(app.db.getDatabase());
  const links = new NeoTodoSessionRepository(app.db.getDatabase());
  store.openAsk({ id: 'synthetic-ask', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Build', createdAt: Date.now() });
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Build', doneWhen: 'Built', instruction: 'Stay quiet except blockers.', check: null, named: null }, Date.now());
  links.create(todo.id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'test', name: 'Synthetic' } });
  links.recordRef(todo.id, { adapter: 'hyperneo', id: 'synthetic-worker' }, Date.now());
  store.updateTodo(todo, { state: 'doing', startedAt: Date.now() }, Date.now());
  const report = async (title: string) => {
    await workerSend({ to: root, kind: 'blocked', text: 'Need a decision', question: { todoId: todo.id, title, options: ['Staging', 'Production'], language: 'en' } });
    const question = store.listQuestions(todo.askId).find((question) => question.state === 'open'); assert(question); return question;
  };
  const first = await report('Choose the preview destination');
  const invalid = await rpc('neo.question.resolve', { questionId: first.id, answer: ['Staging'], source: { kind: 'rule', text: 'Not a saved rule' } });
  assert.equal(invalid.ok, false); assert.equal(store.getQuestion(first.id)?.state, 'open'); assert.equal(store.getTodo(todo.id)?.blockedBy, 'needs-human');
  questionToResolve = first.id;
  app.jobProcessor.start();
  await until(() => store.getQuestion(first.id)?.state === 'retired', 'the real Neo SDK tool must resolve the card from its saved rule');
  const ruleRead = await rpc('neo.question.get', { questionId: first.id });
  assert(issued); assert.equal(ruleRead.answeredByHuman, false); assert.equal(ruleRead.resolvedByAgent, true); assert.equal(ruleRead.answerDelivery[0].answeredBy, 'rule'); assert.equal(ruleRead.answerDelivery[0].state, 'accepted');
  await until(() => app!.db.getSDKMessageRepo().getUserSendStatus('synthetic-worker', ruleRead.answerDelivery[0].receipt) === 'consumed', 'the worker SDK must consume the agent resolution');
  await Bun.sleep(1000); await app.jobProcessor.stop();
  const prior = store.askQuestion('earlier-human', todo.askId, { text: 'Earlier preview destination', kind: 'choice', options: ['Staging', 'Production'], multiple: false, noLabel: null, yesLabel: null, startTodos: null }, Date.now());
  await rpc('neo.question.answer', { questionId: prior.id, answer: ['Staging'] });
  const next = await report('Choose the next preview destination');
  assert.equal((await rpc('neo.question.resolve', { questionId: next.id, answer: ['Staging'], source: { kind: 'answer', questionId: first.id } })).ok, false, 'an agent resolution cannot be recited as human approval');
  assert.equal((await rpc('neo.question.resolve', { questionId: next.id, answer: ['Staging'], source: { kind: 'answer', questionId: prior.id } })).ok, true);
  const priorRead = await rpc('neo.question.get', { questionId: next.id });
  assert.equal(priorRead.answeredByHuman, false); assert(priorRead.question.retiredReason.includes(prior.id));
  app.jobProcessor.start();
  await until(() => app!.db.getSDKMessageRepo().getUserSendStatus('synthetic-worker', priorRead.answerDelivery[0].receipt) === 'consumed', 'the cited prior answer must reach the worker SDK');
  await Bun.sleep(1000); await app.jobProcessor.stop();
  const failedQuestion = await report('Choose the destination after recovery');
  await app.db.updateSession('synthetic-worker', { status: 'archived' });
  assert.equal((await rpc('neo.question.resolve', { questionId: failedQuestion.id, answer: ['Staging'], source: { kind: 'rule', text: rule } })).ok, true);
  const failed = await rpc('neo.question.get', { questionId: failedQuestion.id });
  assert.equal(failed.answerDelivery[0].state, 'pending'); assert.equal(store.getTodo(todo.id)?.blockedBy, 'needs-human');
  await rpc('neo.rule.save', { remove: [rule] });
  await app.cleanup(); app = undefined; phase = 'restarted';
  app = await createDaemonApp({ config, verbose: false }); await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  store = new NeoAskTodoRepository(app.db.getDatabase());
  await app.db.updateSession('synthetic-worker', { status: 'active' });
  app.db.getDatabase().prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
  app.jobProcessor.start();
  await until(() => store.questionAnswers.list(failedQuestion.id)[0]?.state === 'accepted', 'restart must recover the retired card through the existing delivery path');
  const recovered = await rpc('neo.question.get', { questionId: failedQuestion.id });
  await until(() => app!.db.getSDKMessageRepo().getUserSendStatus('synthetic-worker', recovered.answerDelivery[0].receipt) === 'consumed', 'the recovered resolution must reach the worker SDK');
  await rpc('neo.message.send', { sessionId: root, requestId: crypto.randomUUID(), content: 'Continue the synthetic plan.' });
  await until(() => neoBodies.some((entry) => entry.phase === 'restarted' && entry.body.includes(JSON.stringify(`Neo resolved "${failedQuestion.text}"`).slice(1, -1)) && entry.body.includes(rule)), 'Neo must retain the agent resolution and citation in its real SDK context after restart');
  await app.jobProcessor.stop();
  const reads = [ruleRead, priorRead, recovered];
  const counts = reads.map((read) => app!.db.getDatabase().prepare("SELECT COUNT(*) AS count FROM sdk_messages WHERE session_id = 'synthetic-worker' AND sdk_uuid = ? AND message_type = 'user'").get(read.answerDelivery[0].receipt));
  assert(counts.every((row) => row.count === 1), JSON.stringify(counts));
  assert.equal(recovered.answeredByHuman, false); assert.equal(recovered.resolvedByAgent, true); assert(recovered.question.retiredReason.includes(rule)); assert.equal(store.getTodo(todo.id)?.state, 'doing');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ issuedByNeoSdk: issued, invalid, ruleRead, priorRead, failed, recovered, counts, todo: store.getTodo(todo.id), neoContextAfterRestart: true }, null, 2));
  console.log('PASS: cited Neo resolution retires cards, reaches the worker once, retains holds on failure, and preserves non-human provenance through restart');
} finally {
  await app?.cleanup(); model.stop(true);
  QueryOptionsBuilder.prototype.build = build; ProviderService.prototype.resolveSessionProviderEnvVars = sessionEnv; ProviderService.prototype.getEnvVarsForModel = modelEnv;
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
