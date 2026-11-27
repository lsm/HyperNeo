import assert from 'node:assert/strict';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[name]);
mkdirSync(join(run, 'evidence'), { recursive: true });

const seen: string[] = [];
const overloaded = new Set<string>();
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/models')) return Response.json({ data: [] });
  if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 20 });
  if (!path.endsWith('/messages')) return Response.json({});
  const body = await request.json() as { model: string; stream?: boolean; messages?: unknown[] };
  if (body.stream) seen.push(body.model);
  if (overloaded.has(body.model))
    return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
  const usage = { input_tokens: 20, output_tokens: 5 };
  const message = { id: 'msg_list', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });

const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
assert(![8399, 8499].includes(app.server.port));
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: (url) => createLocalSocket(url),
});
hub.registerTransport(transport);
const endpoint = (id: string, type: 'anthropic-messages' | 'openai-chat') =>
  hub.request('customEndpoints.add', { endpoint: {
    id, name: id, type, baseUrl: `http://127.0.0.1:${mock.port}`, models: [{ id, name: id }],
  } });
try {
  await app.jobProcessor.stop();
  await transport.connect();
  await endpoint('eyes-off', 'openai-chat');
  await endpoint('desk-first', 'anthropic-messages');
  await endpoint('desk-second', 'anthropic-messages');
  await hub.request('models.list', { forceRefresh: true });
  const list = [
    { provider: 'custom:eyes-off', model: 'eyes-off' },
    { provider: 'custom:desk-first', model: 'desk-first', thinkingLevel: 'think8k' },
    { provider: 'custom:desk-second', model: 'desk-second' },
  ];
  await hub.request('settings.global.update', { updates: { desktopControlModels: list } });
  const sql = app.db.getDatabase();
  const now = new Date().toISOString();
  const root = `neo:${crypto.randomUUID()}`;
  sql.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic Neo', ?, ?, ?, 'active', ?, '{}')")
    .run(root, run, now, now, JSON.stringify({ model: 'desk-second', provider: 'custom:desk-second' }));
  new NeoRepository(sql).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const neo = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const fromNeo = async (name: string, input: Record<string, unknown>) =>
    JSON.parse((await neo({ name, input })).content[0].text);
  app.jobProcessor.start();
  const ask = new NeoAskTodoRepository(sql);
  const desktopTodo = async (title: string) => {
    const opened = await fromNeo('neo.ask.propose', { title, request: `${title}?`, desktopApps: ['com.apple.calculator'] });
    assert(opened.ok, JSON.stringify(opened));
    const answered = await hub.request<{ ok: boolean }>('operation.invoke', {
      name: 'neo.question.answer', input: { questionId: ask.listQuestions(opened.ask.id)[0]!.id, answer: 'yes' },
    });
    assert(answered.ok, JSON.stringify(answered));
    return fromNeo('neo.todo.add', {
      askId: opened.ask.id, title, after: [], instruction: `${title}.`, desktopApps: ['com.apple.calculator'],
      check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'evidence', 'done') } },
      target: { verb: 'start', adapter: 'hyperneo', place: { machine: hostname(), folder: run, name: 'Synthetic workspace' } },
    });
  };

  const added = await desktopTodo('Read the Calculator display');
  assert(added.ok && added.todo, JSON.stringify(added));
  const ref = new NeoTodoSessionRepository(sql).readRef(added.todo.id);
  assert(ref, JSON.stringify(added));
  const worker = (await app.sessionManager.getSessionAsync(ref.id))!.getSessionData();
  for (let i = 0; i < 300 && !seen.length; i++) await delay(100);
  const started = {
    template: worker.metadata.workerTemplate,
    model: worker.config.model,
    provider: worker.config.provider,
    effort: worker.config.thinkingLevel,
    chain: worker.metadata.desktopControlChain,
    modelRequests: seen,
  };
  writeFileSync(join(run, 'evidence/desktop-model-list-start.json'), JSON.stringify(started, null, 2));
  assert.deepEqual(started, {
    template: 'worker.desktop',
    model: 'desk-first',
    provider: 'custom:desk-first',
    effort: 'think8k',
    chain: list.slice(1),
    modelRequests: ['desk-first'],
  });
  console.log('desktop model list start PASS model=desk-first chain=2 skipped=eyes-off');

  overloaded.add('desk-first');
  const before = seen.length;
  const moved = await desktopTodo('Read the Calculator memory');
  assert(moved.ok && moved.todo, JSON.stringify(moved));
  const movedRef = new NeoTodoSessionRepository(sql).readRef(moved.todo.id)!;
  for (let i = 0; i < 3000; i++) {
    const data = (await app.sessionManager.getSessionAsync(movedRef.id))!.getSessionData();
    if (data.config.model === 'desk-second') break;
    await delay(100);
  }
  const movedData = (await app.sessionManager.getSessionAsync(movedRef.id))!.getSessionData();
  const recovered = {
    model: movedData.config.model,
    provider: movedData.config.provider,
    modelLimits: movedData.metadata.modelLimits ?? null,
    modelRequests: seen.slice(before),
  };
  writeFileSync(join(run, 'evidence/desktop-model-list-recovered.json'), JSON.stringify(recovered, null, 2));
  assert.equal(recovered.model, 'desk-second', JSON.stringify(recovered));
  assert.equal(recovered.provider, 'custom:desk-second', JSON.stringify(recovered));
  assert.equal(recovered.modelLimits, null, JSON.stringify(recovered));
  assert(recovered.modelRequests.filter((model) => model === 'desk-first').length > 1, JSON.stringify(recovered));
  console.log(`desktop model list overload PASS moved desk-first -> desk-second with no model limit recorded`);

  await hub.request('settings.global.update', { updates: { desktopControlModels: list.slice(0, 1) } });
  const requestsBefore = seen.length;
  const refused = await desktopTodo('Read the Calculator display again');
  const refusedTodo = refused.todo ? ask.getTodo(refused.todo.id) : null;
  const outcome = {
    added: refused.ok,
    bound: refused.todo ? !!new NeoTodoSessionRepository(sql).readRef(refused.todo.id) : false,
    state: refusedTodo?.state ?? null,
    blockedReason: refusedTodo?.blockedReason ?? null,
    error: refused.error ?? refused.reason ?? null,
    modelRequests: seen.slice(requestsBefore),
  };
  writeFileSync(join(run, 'evidence/desktop-model-list-refused.json'), JSON.stringify(outcome, null, 2));
  assert.equal(outcome.bound, false, JSON.stringify(outcome));
  assert(!outcome.modelRequests.includes('eyes-off'), JSON.stringify(outcome));
  assert.match(JSON.stringify(outcome), /desktop-control model list/, JSON.stringify(outcome));
  console.log('desktop model list exhausted PASS refused without the default model');
} finally {
  transport.disconnect?.();
  await app.cleanup?.();
  mock.stop(true);
}
process.exit(0);
