import assert from 'node:assert/strict';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import catalog from '../../../packages/daemon/src/lib/desktop/tool-catalog.json' with { type: 'json' };
import { DesktopTurn } from '../../../packages/daemon/src/lib/desktop/host-dispatch.ts';
import { operationInvoke } from '../../../packages/daemon/tests/helpers/operation-mcp.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { planSessionDoorCall } from '../../../packages/daemon/src/lib/messaging/session-door.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
const collapse = process.argv.includes('--collapse');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[name]);
mkdirSync(join(run, 'data/desktop'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin', 'gh'));
chmodSync(join(run, 'bin', 'gh'), 0o755);
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
const model = 'desktop-template-proof';
const instruction = 'Identify the open Calculator window.';
const ordinaryInstruction = 'Summarize this ordinary task.';
const bundleId = 'com.apple.calculator';
const otherApp = 'com.apple.TextEdit';
const toolPrefix = 'mcp__desktop__';
const modelTools = ['report', ...catalog.map(({ name }) => name)].map(name => toolPrefix + name);
const reportText = 'Calculator observation recorded.';
const toolCalls = [
  { name: 'get_window_state', input: { pid: 123, window_id: 7, timeout_ms: 1000, since: 'latest' } },
  { name: 'launch_app', input: { bundle_id: otherApp } },
  { name: 'report', input: { kind: 'done', text: reportText } },
];
const modelRequest = Promise.withResolvers<{ tools: string[]; system: string; brief: string }>();
const ordinaryRequest = Promise.withResolvers<string>();
type ModelBlock = { type: string; tool_use_id?: string; content?: string | { type: string; text?: string }[] };
const modelResults = Promise.withResolvers<ModelBlock[]>();
let modelStep = 0;
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/models')) return Response.json({ data: [{ id: model, type: 'model' }] });
  if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 20 });
  if (!path.endsWith('/messages')) return Response.json({});
  const body = await request.json() as { stream?: boolean; tools?: { name: string }[]; system?: unknown; messages?: { content: string | ModelBlock[] }[] };
  const brief = JSON.stringify(body.messages ?? []);
  if (body.stream && brief.includes(ordinaryInstruction) && brief.includes('Worker delivery:'))
    ordinaryRequest.resolve(brief);
  if (brief.includes(instruction)) modelRequest.resolve({
    tools: (body.tools ?? []).map(({ name }) => name),
    system: JSON.stringify(body.system ?? ''),
    brief,
  });
  const command = body.stream && brief.includes(instruction) ? toolCalls[modelStep++] : undefined;
  if (body.stream && brief.includes(instruction) && modelStep === toolCalls.length + 1) {
    modelResults.resolve((body.messages ?? []).flatMap(({ content }) =>
      typeof content === 'string' ? [] : content.filter(block => block.type === 'tool_result')
    ));
  }
  const usage = { input_tokens: 20, output_tokens: 5 };
  const block = command
    ? { type: 'tool_use', id: `toolu_desktop_${modelStep}`, name: toolPrefix + command.name, input: {} }
    : { type: 'text', text: '' };
  const text = 'Synthetic desktop reply.';
  const stopReason = command ? 'tool_use' : 'end_turn';
  const message = { id: `msg_desktop_proof_${modelStep}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: stopReason, stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: command
      ? { type: 'input_json_delta', partial_json: JSON.stringify(command.input) }
      : { type: 'text_delta', text } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const requests: Record<string, unknown>[] = [];
const cancelTurn = Promise.withResolvers<() => void>();
const pendingDispatch = Promise.withResolvers<() => void>();
let holdDispatch = false;
let legacyHost = false;
let hostBusy = false;
let hostTimeout = false;
let hostLocked = false;
let secretObservation = false;
const token = 'ghp_' + 'SyntheticToken012345678901234567890123';
const driverError = {
  content: [{ type: 'text', text: 'No screenshot of window 7: call get_window_state first' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
  structuredContent: { code: 'no_screenshot' },
};
const host = createServer(socket => {
  let line = '';
  socket.on('data', chunk => {
    line += chunk;
    if (!line.includes('\n')) return;
    const request = JSON.parse(line);
    requests.push(request);
    if (request.action === 'cancelTurn') {
      if (legacyHost) {
        socket.end(JSON.stringify({ ok: false, error: 'unknown field `callIds`, expected a dispatch field' }) + '\n');
        return;
      }
      cancelTurn.resolve(() => socket.end('{"ok":true,"result":{"state":"stopped"}}\n'));
      return;
    }
    assert.deepEqual(Object.keys(request).sort(), ['action', 'apps', 'arguments', 'callId', 'todo', 'todos', 'tool', 'workDir', 'worker']);
    if (holdDispatch) {
      pendingDispatch.resolve(() => socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: null, class: null, decision: 'refused', reason: 'turn_stopped', dispatched: false } }) + '\n'));
      return;
    }
    if (hostBusy) {
      socket.end(JSON.stringify({ ok: false, error: 'desktop_busy' }) + '\n');
      return;
    }
    if (hostTimeout || hostLocked) {
      const reason = hostLocked ? 'screen_locked' : 'desktop_timeout';
      socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: 'org.example.fixture', class: 'pointer', decision: 'refused', reason, dispatched: false } }) + '\n');
      return;
    }
    if (request.tool === 'launch_app' && !request.apps.includes(request.arguments.bundle_id)) {
      socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: request.arguments.bundle_id, class: null, decision: 'refused', reason: 'app_not_in_todo_scope', dispatched: false } }) + '\n');
      return;
    }
    const body = secretObservation
      ? { reason: null, content: [{ type: 'text', text: token }, driverError.content[1]], structuredContent: { accessibilityTree: token } }
      : request.tool === 'get_window_state' ? { reason: 'driver_error', ...driverError } : { reason: null };
    socket.end(JSON.stringify({ ok: true, result: { call_id: request.callId, bundle_id: request.apps[0], class: 'pointer', decision: 'allowed', dispatched: true, ...body } }) + '\n');
  });
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: (url) => createLocalSocket(url),
});
hub.registerTransport(transport);
try {
  await app.jobProcessor.stop();
  host.listen(join(run, 'data/desktop/control.sock'));
  await once(host, 'listening');
  await transport.connect();
  await hub.request('customEndpoints.add', { endpoint: {
    id: model, name: 'Synthetic desktop endpoint', type: 'anthropic-messages',
    baseUrl: `http://127.0.0.1:${mock.port}`, models: [{ id: model, name: 'Synthetic desktop model', capabilities: { toolUse: true } }],
  } });
  await hub.request('models.list', { forceRefresh: true });
  await hub.request('settings.global.update', { updates: { coordinatorMode: true } });
  const sql = app.db.getDatabase();
  const now = Date.now();
  const root = `neo:${crypto.randomUUID()}`;
  const modelConfig = { model, provider: `custom:${model}` as const };
  sql.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic Neo', ?, ?, ?, 'active', ?, '{}')").run(root, run, new Date(now).toISOString(), new Date(now).toISOString(), JSON.stringify(modelConfig));
  new NeoRepository(sql).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const registry = app.sessionManager.getOperationRegistry();
  const neo = createOperationMcpHandler(registry, () => ({ sessionId: root, role: 'neo' }));
  const fromNeo = async (name: string, input: Record<string, unknown>) =>
    JSON.parse((await neo({ name, input })).content[0].text);
  app.jobProcessor.start();
  const ordinary = await fromNeo('neo.ask.propose', { title: 'Ordinary task', request: ordinaryInstruction });
  assert(ordinary.ok, JSON.stringify(ordinary));
  const ask = new NeoAskTodoRepository(sql);
  const ordinaryAnswer = await hub.request<{ ok: boolean }>('operation.invoke', {
    name: 'neo.question.answer', input: { questionId: ask.listQuestions(ordinary.ask.id)[0]!.id, answer: 'yes' },
  });
  assert(ordinaryAnswer.ok, JSON.stringify(ordinaryAnswer));
  const ordinaryTodo = await fromNeo('neo.todo.add', {
    askId: ordinary.ask.id, title: 'Ordinary task', instruction: ordinaryInstruction, after: [],
    check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'evidence', 'ordinary') } },
    target: { verb: 'start', adapter: 'hyperneo', ...modelConfig, place: { machine: hostname(), folder: run, name: 'Synthetic workspace' } },
  });
  assert(ordinaryTodo.ok && ordinaryTodo.todo, JSON.stringify(ordinaryTodo));
  const ordinaryBrief = await Promise.race([
    ordinaryRequest.promise,
    delay(30_000, undefined, { ref: false }).then(() => { throw new Error('No model request for the ordinary todo'); }),
  ]);
  const ordinaryText = (JSON.parse(ordinaryBrief) as { role: string; content: { text?: string }[] }[])
    .flatMap(({ content }) => content.map(({ text }) => text ?? '')).join('\n')
    .split('\n# Environment')[0]
    .replaceAll(root, '<sender>')
    .replaceAll(run, '<run>')
    .replaceAll(ordinaryTodo.todo.id, '<task>')
    .replace(/Worker delivery: [0-9a-f-]+/, 'Worker delivery: <delivery>');
  writeFileSync(join(run, 'evidence/ordinary-worker-brief.txt'), ordinaryText);
  const opened = await fromNeo('neo.ask.propose', { title: 'Inspect Calculator', request: 'Inspect the Calculator window?', desktopApps: [bundleId] });
  assert(opened.ok, JSON.stringify(opened));
  const card = ask.listQuestions(opened.ask.id)[0]!;
  assert(card.text.includes('The worker and its model will see everything these apps show, on every page.'));
  const answered = await hub.request<{ ok: boolean }>('operation.invoke', {
    name: 'neo.question.answer', input: { questionId: card.id, answer: 'yes' },
  });
  assert(answered.ok, JSON.stringify(answered));
  secretObservation = true;
  const added = await fromNeo('neo.todo.add', {
    askId: opened.ask.id, title: 'Identify the Calculator window', after: [],
    check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'evidence', 'complete') } },
    instruction,
    target: { verb: 'start', adapter: 'hyperneo', ...modelConfig, place: { machine: hostname(), folder: run, name: 'Synthetic workspace' } },
    desktopApps: [bundleId],
  });
  assert(added.ok && added.todo, JSON.stringify(added));
  const ref = new NeoTodoSessionRepository(sql).readRef(added.todo.id);
  assert(ref, JSON.stringify(added));
  const templated = await app.sessionManager.getSessionAsync(ref.id);
  assert(templated);
  assert.equal(templated.getSessionData().metadata.workerTemplate, 'worker.desktop');
  const outbound = await Promise.race([
    modelRequest.promise,
    delay(30_000, undefined, { ref: false }).then(() => { throw new Error('No model request for the Calculator todo'); }),
  ]);
  assert.deepEqual([...outbound.tools].sort(), [...modelTools].sort());
  assert.match(outbound.system, /using the desktop tools in approved apps/);
  assert.match(outbound.system, /Put any exact text you will need in your own reply/);
  assert(!outbound.brief.includes('desktop_permissions_required'));
  const results = await Promise.race([
    modelResults.promise,
    delay(30_000, undefined, { ref: false }).then(() => { throw new Error('No native desktop tool results reached the model'); }),
  ]);
  await app.jobProcessor.stop();
  const init = app.db.getSDKMessagesByType(ref.id, 'system', 'init').find(
    (message) => message.type === 'system' && message.subtype === 'init'
  );
  assert(init, 'No Claude Code startup inventory was recorded');
  const { commandsData } = await hub.request<{ commandsData: { availableCommands: string[] } }>(
    'state.session', { sessionId: ref.id }
  );
  const inventory = {
    claudeCodeVersion: init.claude_code_version,
    tools: init.tools,
    modelTools: outbound.tools,
    skills: init.skills,
    slashCommands: init.slash_commands,
    terminalSlashCommands: init.terminal_slash_commands,
    agents: init.agents,
    composerCommands: commandsData.availableCommands,
    systemPrompt: JSON.parse(outbound.system),
    taskBrief: JSON.parse(outbound.brief),
  };
  writeFileSync(join(run, 'evidence/desktop-worker-inventory.json'), JSON.stringify(inventory, null, 2));
  const expectedDesktopTools = ['report', ...catalog.map(({ name }) => name)]
    .map(name => 'mcp__desktop__' + name).sort();
  assert.deepEqual([...outbound.tools].sort(), expectedDesktopTools);
  assert.doesNotMatch((outbound.system + outbound.brief).replaceAll(run, '<fixture>'), /\bneo\b|hyperneo|operations\.describe|message\.send|Most non-coding tasks/i);
  assert.deepEqual([...init.tools].sort(), [...modelTools].sort());
  assert.deepEqual(init.skills, []);
  assert.deepEqual(init.slash_commands, []);
  assert.deepEqual(init.terminal_slash_commands ?? [], []);
  assert.deepEqual(init.agents ?? [], []);
  assert.deepEqual(inventory.composerCommands, []);
  assert.doesNotMatch(outbound.system + outbound.brief, /deep-research|statusline-setup|Available agent types/i);
  console.log(`desktop worker inventory PASS sdk_tools=${init.tools.length} model_tools=${outbound.tools.length} skills=0 slash_commands=0 agents=0 composer_commands=0`);
  assert.equal(results.length, 3);
  const [capture, refusal, sent] = results;
  assert(Array.isArray(refusal.content));
  const refused = JSON.parse(refusal.content[0].text ?? '');
  assert(Array.isArray(sent.content));
  assert.equal(sent.content[0]?.text, 'Report received.');
  const pendingReports = app.db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': root });
  const received = app.db.getSDKMessagesByType(root, 'user');
  assert(JSON.stringify([...pendingReports, ...received]).includes(reportText), 'Result did not reach the assigning session');
  assert.equal(refused.reason, 'app_not_in_todo_scope');
  assert.equal(refused.dispatched, false);
  assert(Number.isFinite(Date.parse(refused.at)));
  assert(Number.isInteger(refused.ms) && refused.ms >= 0);
  if (collapse) {
    assert.equal(capture.content, 'get_window_state pid=123 window_id=7 ok');
  } else {
    assert(Array.isArray(capture.content));
    const captured = JSON.parse(capture.content[0].text ?? '');
    assert.equal(captured.ok, true);
    assert(Number.isFinite(Date.parse(captured.at)));
    assert(Number.isInteger(captured.ms) && captured.ms >= 0);
    assert.match(capture.content[1]?.text ?? '', /redacted/);
  }
  assert(!JSON.stringify(results).includes(token));
  const stored = JSON.stringify(app.db.getSDKMessages(ref.id, 30).messages);
  assert.match(stored, /Desktop observation redacted because it contains a possible secret/);
  assert(!stored.includes('get_window_state pid=123 window_id=7 ok'));
  assert.deepEqual(requests.map(({ tool, arguments: args, apps }) => ({ tool, args, apps })),
    toolCalls.slice(0, 2).map(({ name, input }) => {
      const { since, ...full } = 'since' in input ? input : { ...input, since: undefined };
      return { tool: name, args: collapse ? full : input, apps: [bundleId] };
    }));
  console.log(`desktop snapshot journey PASS collapse=${collapse} dispatches=${requests.length} kept_full=${collapse ? 1 : 2} since_forwarded=${!collapse}`);
  requests.length = 0;
  sql.prepare("DELETE FROM mcp_audit_log WHERE session_id = ?").run(ref.id);
  const options = await templated.optionsBuilder.build();
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, modelTools);
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ['desktop']);
  assert(options.systemPrompt && typeof options.systemPrompt === 'object');
  assert.equal(options.systemPrompt.type, 'custom');
  const [registrySource, resolveCaller, recordRefusal] = templated.getOperationMcpRegistration();
  const templateCall = createOperationMcpHandler(registrySource, resolveCaller, recordRefusal);
  for (const name of ['operations.list', 'operations.describe', 'file.reference.read']) {
    const denied = await templateCall({ name, input: {} });
    assert.equal(JSON.parse(denied.content[0].text).code, 'forbidden');
  }
  const observation = { name: 'desktop.call', input: { tool: 'get_window_state', args: { pid: 123, window_id: 7 } } };
  secretObservation = true;
  const redacted = await templateCall(observation);
  secretObservation = false;
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].apps, [bundleId]);
  assert.equal(redacted.content.length, 2);
  assert.equal(redacted.content[1].type, 'text');
  assert.match(JSON.stringify(redacted.content[1]), /redacted/);
  assert(!JSON.stringify(redacted).includes(token));
  const setScope = (apps: { bundleId: string; name: string; seen?: 'all' }[]) =>
    sql.prepare('UPDATE neo_asks SET desktop_apps = ? WHERE id = ?').run(JSON.stringify(apps), opened.ask.id);
  const reasonForCapture = async () => JSON.parse((await templateCall(observation)).content[0].text).reason;
  setScope([{ bundleId: 'com.apple.TextEdit', name: 'TextEdit', seen: 'all' }]);
  assert.equal(await reasonForCapture(), 'desktop_not_enabled');
  setScope([{ bundleId, name: 'Calculator' }]);
  assert.equal(await reasonForCapture(), 'desktop_consent_outdated');
  sql.prepare('UPDATE neo_todos SET approved_at = NULL WHERE id = ?').run(added.todo.id);
  assert.equal(await reasonForCapture(), 'desktop_consent_outdated');
  assert.equal(requests.length, 1);
  setScope([{ bundleId, name: 'Calculator', seen: 'all' }]);
  sql.prepare('UPDATE neo_todos SET approved_at = ? WHERE id = ?').run(now, added.todo.id);
  const { instance } = templated.getOperationMcpServer();
  const report = (instance as unknown as {
    _registeredTools: { report: { handler: ReturnType<typeof createOperationMcpHandler> } };
  })._registeredTools.report.handler;
  for (const kind of ['question', 'blocked']) {
    const title = kind === 'question' ? 'Use Calculator now?' : 'Allow Calculator access?';
    const reply = await report({ kind, text: title, question: { title, options: ['Yes', 'No'], language: 'en' } });
    assert.equal(reply.content[0].text, 'Report received.');
    assert.equal(ask.getTodo(added.todo.id)?.blockedReason, title);
    assert.equal(new NeoTodoSessionRepository(sql).readNudge(added.todo.id)?.workerQuestion?.title, title);
  }
  await hub.request('settings.global.update', { updates: { coordinatorMode: false } });
  writeFileSync(join(run, 'evidence/desktop-worker-template.json'), JSON.stringify({
    card: card.text, template: 'worker.desktop', builtins: options.tools, allowedTools: options.allowedTools,
    mcpServers: Object.keys(options.mcpServers ?? {}), reports: 3, denied: true, redacted: true,
    modelTools: outbound.tools, templatePrompt: true, shortBrief: true, rejectedCaptures: 3,
    capture: capture.content, refused, collapse, fullCaptureStored: true,
  }, null, 2));
  console.log(`desktop worker template journey PASS builtins=0 mcp_tools=${modelTools.length} report_kinds=3 denied_operations=3 timed_native_results=${collapse ? 1 : 2} redacted_observations=2 rejected_captures=3`);
  requests.length = 0;
  sql.prepare("DELETE FROM mcp_audit_log WHERE session_id = ?").run(ref.id);
  const worker = await app.sessionManager.createSession({ workspacePath: run, title: 'Synthetic desktop worker', config: modelConfig });
  const agent = app.sessionManager.getSession(worker)!;
  assert(agent);
  const fixtureApps = JSON.stringify([{ bundleId: 'org.example.fixture', name: 'Fixture' }]);
  const disclosedApps = JSON.stringify([
    { bundleId: 'org.example.fixture', name: 'Fixture', seen: 'all' },
    { bundleId: 'org.example.other', name: 'Other', seen: 'all' },
  ]);
  sql.prepare("INSERT INTO neo_asks(id,session_id,title,request,status,desktop_apps,created_at,updated_at) VALUES('ask','neo:fixture','Synthetic action','','open',?,?,?)").run(disclosedApps, now, now);
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,desktop_apps,created_at,updated_at) VALUES('todo','ask',0,'Synthetic click','Observed',?, 'doing',?,?,?,?)").run(JSON.stringify({ desktopControl: true }), now, fixtureApps, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('todo', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: worker }));
  const call = operationInvoke(agent.getOperationMcpServer());
  const described = JSON.stringify(JSON.parse((await call({ name: 'operations.describe', input: { name: 'desktop.call' } })).content[0].text));
  const listedTools = catalog.filter(tool => described.includes(`"const":"${tool.name}"`));
  assert.equal(listedTools.length, catalog.length, described);
  assert(described.includes('list the windows of every app this todo may use'));
  assert(described.includes('For * and other shifted symbols, send the base key with shift'));
  assert(described.includes('Unknown key names return driver_error'));
  const input = { tool: 'click', args: { pid: 123, x: 5, y: 7 } };
  sql.prepare("UPDATE neo_todos SET desktop_apps=NULL WHERE id='todo'").run();
  const noScope = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(noScope.reason, 'desktop_not_enabled');
  assert.equal(noScope.dispatched, false);
  assert.equal(requests.length, 0);
  sql.prepare("UPDATE neo_todos SET desktop_apps=? WHERE id='todo'").run(fixtureApps);
  const allowed = await call({ name: 'desktop.call', input });
  const reply = JSON.parse(allowed.content[0].text);
  assert.equal(reply.dispatched, true, JSON.stringify(allowed));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, 'dispatch');
  assert.equal(requests[0].worker, worker);
  assert.equal(requests[0].workDir, run);
  assert.deepEqual(requests[0].arguments, input.args);
  assert.deepEqual(requests[0].apps, ['org.example.fixture']);
  const audit = sql.prepare("SELECT session_id, params_summary FROM mcp_audit_log WHERE tool_name='desktop.call'").all() as Array<{ session_id: string; params_summary: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].session_id, worker);
  assert.deepEqual(JSON.parse(audit[0].params_summary), { todo: 'todo', session: worker, tool: 'click', app: 'org.example.fixture', class: 'pointer', decision: 'allowed', reason: null, dispatched: true });
  const failed = await call({ name: 'desktop.call', input: { tool: 'get_window_state', args: { pid: 123, window_id: 7 } } });
  const failure = JSON.parse(failed.content[0].text);
  assert.equal(failure.ok, false, JSON.stringify(failed));
  assert.equal(failed.isError, true);
  assert.notEqual(allowed.isError, true);
  assert.equal(failure.reason, 'driver_error');
  assert.deepEqual(failure.structuredContent, driverError.structuredContent);
  assert.deepEqual(failed.content.slice(1), driverError.content);
  const audited = sql.prepare("SELECT params_summary FROM mcp_audit_log WHERE tool_name='desktop.call' ORDER BY rowid").all() as Array<{ params_summary: string }>;
  assert.equal(audited.length, 2);
  assert.deepEqual(JSON.parse(audited[1].params_summary), { todo: 'todo', session: worker, tool: 'get_window_state', app: 'org.example.fixture', class: 'pointer', decision: 'allowed', reason: 'driver_error', dispatched: true });
  const rpc = await invokeOperation(registry, 'desktop.call', input, { source: 'rpc', principal: 'local', sessionId: worker, role: 'direct_task_worker' });
  assert(!('value' in rpc) || !(rpc.value as { dispatched?: boolean }).dispatched);
  const door = planSessionDoorCall({ sender: worker, name: 'desktop.call', input });
  assert('reason' in door);
  await call({ name: 'desktop.call', input: { ...input, worker: 'other-worker' } });
  await call({ name: 'desktop.call', input: { tool: 'kill_app', args: {} } });
  sql.prepare("UPDATE neo_todos SET approved_at=NULL WHERE id='todo'").run();
  await call({ name: 'desktop.call', input });
  assert.equal(requests.length, 2);
  sql.prepare("UPDATE neo_todos SET state='blocked', approved_at=? WHERE id='todo'").run(now);
  const blocked = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(blocked.dispatched, true, JSON.stringify(blocked));
  sql.prepare("UPDATE neo_todos SET state='todo' WHERE id='todo'").run();
  const pending = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(pending.dispatched, true, JSON.stringify(pending));
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,desktop_apps,created_at,updated_at) VALUES('older','ask',1,'Older task','Observed',?, 'blocked',?,?,?,?)").run(JSON.stringify({ desktopControl: true }), now, fixtureApps, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('older', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: worker }));
  sql.prepare("UPDATE neo_todos SET state='doing' WHERE id='todo'").run();
  const current = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(current.dispatched, true, JSON.stringify(current));
  const currentAudit = sql.prepare("SELECT params_summary FROM mcp_audit_log WHERE tool_name='desktop.call' ORDER BY rowid DESC LIMIT 1").get() as { params_summary: string };
  assert.equal(JSON.parse(currentAudit.params_summary).todo, 'todo');
  sql.prepare("UPDATE neo_todos SET state='blocked' WHERE id='todo'").run();
  const ambiguous = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(ambiguous.reason, 'todo_ambiguous');
  assert.equal(ambiguous.dispatched, false);
  sql.prepare("UPDATE neo_todos SET state='todo', named='{}', desktop_apps=NULL WHERE id='older'").run();
  const blockedWithQueued = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(blockedWithQueued.dispatched, true, JSON.stringify(blockedWithQueued));
  sql.prepare("UPDATE neo_todos SET state='done' WHERE id='older'").run();
  sql.prepare("UPDATE neo_todos SET state='done' WHERE id='todo'").run();
  const finished = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(finished.reason, 'todo_not_active');
  assert.equal(finished.dispatched, false);
  assert.equal(requests.length, 6);
  sql.prepare("UPDATE neo_todos SET state='doing' WHERE id='todo'").run();
  hostBusy = true;
  const busy = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(busy.reason, 'desktop_busy');
  assert.equal(busy.dispatched, false);
  assert.equal(requests.length, 7);
  hostBusy = false;
  hostTimeout = true;
  const expired = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(expired.reason, 'desktop_timeout');
  assert.equal(expired.dispatched, false);
  assert.equal(requests.length, 8);
  hostTimeout = false;
  const sibling = await app.sessionManager.createSession({ workspacePath: run, title: 'Synthetic sibling worker', config: modelConfig });
  const siblingCall = operationInvoke(app.sessionManager.getSession(sibling)!.getOperationMcpServer());
  sql.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,named,state,approved_at,created_at,updated_at) VALUES('sibling','ask',2,'Sibling task','Observed','{}','doing',?,?,?)").run(now, now, now);
  sql.prepare('INSERT INTO neo_todo_sessions(todo_id,target,ref) VALUES(?,?,?)').run('sibling', JSON.stringify({ adapter: 'hyperneo' }), JSON.stringify({ adapter: 'hyperneo', id: sibling }));
  const isolated = JSON.parse((await siblingCall({ name: 'desktop.call', input })).content[0].text);
  assert.equal(isolated.reason, 'desktop_not_enabled');
  assert.equal(isolated.dispatched, false);
  assert.equal(requests.length, 8);
  sql.prepare("UPDATE neo_todos SET desktop_apps=? WHERE id='sibling'").run(JSON.stringify([{ bundleId: 'org.example.other', name: 'Other' }]));
  const siblingApproved = JSON.parse((await siblingCall({ name: 'desktop.call', input })).content[0].text);
  assert.equal(siblingApproved.dispatched, true, JSON.stringify(siblingApproved));
  assert.equal(requests.length, 9);
  assert.deepEqual(requests[8].apps, ['org.example.other']);
  assert.deepEqual(requests[7].apps, ['org.example.fixture']);
  hostLocked = true;
  const locked = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'screen_locked');
  assert.equal(locked.dispatched, false);
  const lockedAudit = sql.prepare("SELECT params_summary FROM mcp_audit_log WHERE tool_name='desktop.call' ORDER BY rowid DESC LIMIT 1").get() as { params_summary: string };
  assert.equal(JSON.parse(lockedAudit.params_summary).reason, 'screen_locked');
  hostLocked = false;
  const resumed = JSON.parse((await call({ name: 'desktop.call', input })).content[0].text);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(requests.length, 11);
  writeFileSync(join(run, 'evidence/desktop-call.json'), JSON.stringify({ passed: true, hostRequests: requests.length, auditRows: audited.length, hostBusy: true, hostTimeout: true, blockedAllowed: true, pendingAllowed: true, currentPreferred: true, ambiguousRefused: true, blockedWithQueuedAllowed: true, finishedRefused: true, driverErrorBody: true, rpcRefused: true, sessionDoorRefused: true, spoofRefused: true, unlistedRefused: true, unapprovedRefused: true, noScopeRefused: true, siblingIsolated: true, siblingOwnScope: true, hostLocked: true, resumed: true, describedTools: listedTools.length }, null, 2));
  console.log(`desktop.call journey PASS host_requests=11 no_scope_refused=1 sibling_isolated=1 sibling_own_scope=1 host_busy=1 host_timeout=1 host_locked=1 resumed=1 initial_audit_rows=2 blocked_allowed=1 pending_allowed=1 current_preferred=1 ambiguous_refused=1 blocked_with_queued_allowed=1 finished_refused=1 driver_error_body=1 refused_paths=5 described_tools=${listedTools.length}`);

  await agent.stateManager.setProcessing('fixture-input');
  let turn = new DesktopTurn();
  const invokeTurn = operationInvoke(agent.getOperationMcpServer(undefined, () => turn));
  const dispatch = async () => JSON.parse((await invokeTurn({ name: 'desktop.call', input })).content[0].text);
  holdDispatch = true;
  const inFlight = dispatch();
  const refuseInFlight = await Promise.race([
    pendingDispatch.promise,
    inFlight.then((reply) => { throw new Error(`Desktop dispatch completed early: ${JSON.stringify(reply)}`); }),
  ]);
  holdDispatch = false;
  const first = requests.at(-1)!;
  let stopSettled = false;
  const stopWork = () => hub.request('operation.invoke', {
    name: 'work.stop',
    input: { ref: { adapter: 'hyperneo', id: worker } },
  });
  const stop = stopWork().finally(() => { stopSettled = true; });
  const acknowledge = await Promise.race([
    cancelTurn.promise,
    stop.then((response) => { throw new Error(`Work stop returned without Desktop acknowledgment: ${JSON.stringify(response)}`); }),
  ]);
  try {
    assert.deepEqual(requests.at(-1), { action: 'cancelTurn', worker, callIds: [first.callId] });
    await delay(50);
    assert.equal(stopSettled, false);
  } finally {
    acknowledge();
    refuseInFlight();
  }
  const stopped = await stop;
  assert.deepEqual(stopped, { ok: true, value: { stopped: true } });
  assert.equal((await inFlight).reason, 'turn_stopped');
  const { at, ms, ...revoked } = await dispatch();
  assert(Number.isFinite(Date.parse(at)));
  assert(Number.isInteger(ms) && ms >= 0);
  assert.deepEqual(revoked, { ok: false, reason: 'turn_stopped', decision: 'refused', dispatched: false });
  assert.equal(requests.length, 13);
  turn = new DesktopTurn();
  assert.equal((await dispatch()).dispatched, true);
  assert.notEqual(requests.at(-1)!.callId, first.callId);

  legacyHost = true;
  await agent.stateManager.setProcessing('legacy-input');
  assert.equal((await dispatch()).dispatched, true);
  const stoppedWithLegacy = await stopWork();
  assert.deepEqual(stoppedWithLegacy, stopped);
  assert.deepEqual(requests.at(-1), { action: 'cancelTurn', worker, callIds: [] });
  assert.equal((await dispatch()).reason, 'turn_stopped');
  turn = new DesktopTurn();
  assert.equal((await dispatch()).dispatched, true);
  assert.equal(requests.length, 17);
  writeFileSync(join(run, 'evidence/desktop-turn-stop.json'), JSON.stringify({ stopped, stoppedWithLegacy, revokedTurnRefused: true, nextTurnDispatched: true, hostRequests: requests.length - 11 }, null, 2));
  console.log('work.stop journey PASS stop_waited_for_host=1 revoked_turn_refused=1 next_turn_dispatched=1 legacy_stop_degraded=1 host_requests=6');
} finally {
  await transport.close();
  await new Promise<void>(done => host.close(() => done()));
  await app.cleanup();
  await mock.stop(true);
}
