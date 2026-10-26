import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { Server } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { ListToolsRequestSchema } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import type { SessionToolInventory } from '../../../packages/shared/src/types/observed-tool-inventory.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const part of ['home', 'workspace', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const mcp = new Server({ name: 'synthetic-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'navigate', inputSchema: { type: 'object' } }] }));
const mcpClient = new Client({ name: 'synthetic-query', version: '1.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await mcp.connect(b);
await mcpClient.connect(a);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const queries: Array<{ finish: ReturnType<typeof deferred<void>>; status: () => Promise<unknown[]> }> = [];
let preview: ReturnType<typeof Bun.serve> | undefined;
const sdk = await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
  const number = queries.length + 1;
  const entry = { finish: deferred<void>(), status: async () => [{ name: 'browser', status: 'connected', tools: (await mcpClient.listTools()).tools, config: { env: { PRIVATE: 'secret' } }, error: 'private diagnostic' }] };
  queries.push(entry);
  return {
    async *[Symbol.asyncIterator]() {
      const feed = prompt[Symbol.asyncIterator]();
      await feed.next();
      void feed.next().catch(() => {});
      yield { type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: `synthetic-sdk-${number}`, cwd: join(run, 'workspace'), model: 'claude-haiku-4-5-20251001', permissionMode: 'default', apiKeySource: 'user', claude_code_version: 'synthetic', tools: ['Read', `mcp__browser__navigate${number}`], skills: ['playwright'], plugins: [{ name: 'playwright', path: '/private/plugin' }], mcp_servers: [{ name: 'browser', status: 'connected' }], slash_commands: [], output_style: 'default' };
      await entry.finish.promise;
      yield { type: 'result', subtype: 'success', uuid: crypto.randomUUID(), session_id: `synthetic-sdk-${number}`, is_error: false, result: 'Synthetic completed', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn' };
    },
    close: () => entry.finish.resolve(),
    interrupt: async () => { entry.finish.resolve(); },
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setPermissionMode: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    mcpServerStatus: () => entry.status(),
  };
} }));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { port: app.server.port, scriptedSdk: true, syntheticMcpProtocol: true, panelVerified: false };
let settleLateStatus = () => {};
const until = async (check: () => Promise<boolean> | boolean, label: string) => {
  const end = Date.now() + 15000;
  while (!(await check())) { assert(Date.now() < end, label); await new Promise(done => setTimeout(done, 25)); }
};
try {
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'synthetic-never-sent' } });
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic inventory', config: { model: 'haiku', provider: 'anthropic' } });
  const inventory = () => hub.request<SessionToolInventory>('session.getToolInventory', { sessionId });
  const before = queries.length;
  evidence.stopped = await inventory();
  assert.equal((evidence.stopped as SessionToolInventory).state, 'not_running');
  assert.equal(queries.length, before);
  await hub.request('message.send', { sessionId, content: 'Synthetic human input' });
  await until(async () => (await inventory()).state === 'observed', 'SDK init never observed');
  const first = await inventory();
  evidence.attached = first;
  assert(first.tools.includes('mcp__browser__navigate1'));
  assert.deepEqual(first.mcpServers, [{ name: 'browser', status: 'connected', tools: ['navigate'] }]);
  assert(!JSON.stringify(first).match(/secret|private|config|error/));
  if (process.argv.includes('--show-panel') || process.argv.includes('--show-task-panel')) {
    process.once('SIGUSR1', () => queries[0].finish.resolve());
    process.once('SIGUSR2', () => {
      if (process.argv.includes('--fail-inventory')) {
        app.sessionManager.getSession(sessionId)!.getToolInventory = async () => { throw new Error('Synthetic inventory read failure'); };
        return;
      }
      queries[0].status = async () => {
      if (process.argv.includes('--slow-status')) await new Promise(done => setTimeout(done, 2500));
      return [{ name: 'browser', status: 'needs-auth' }];
    }; });
    for (const name of ['browser', 'configured-browser']) {
      const { server } = await hub.request<{ server: { id: string } }>('mcp.registry.create', { name: `${name}-server`, sourceType: 'stdio', command: 'synthetic-not-executed', args: [], enabled: true });
      await hub.request('skill.create', { params: { name, displayName: name === 'browser' ? 'Observed browser' : 'Configured browser (absent from SDK)', description: 'Synthetic panel verification', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: server.id }, enabled: true, validationStatus: 'valid' } });
    }
    const agent = app.sessionManager.getSession(sessionId)!;
    agent.getSessionData().config.mcpServers = { ...agent.getSessionData().config.mcpServers, 'configured-only': { type: 'sdk', name: 'configured-only', instance: {} as never } };
    let panelPath = `/session/${sessionId}`;
    if (process.argv.includes('--show-task-panel')) {
      await app.jobProcessor.stop();
      const { SpaceRepository } = await import('../../../packages/daemon/src/storage/repositories/space-repository.ts');
      const { SpaceTaskRepository } = await import('../../../packages/daemon/src/storage/repositories/space-task-repository.ts');
      const db = app.db.getDatabase();
      const space = new SpaceRepository(db).createSpace({ name: 'Synthetic Tools Space', slug: 'synthetic-tools', workspacePath: join(run, 'workspace') });
      const tasks = new SpaceTaskRepository(db);
      const task = tasks.createTask({ spaceId: space.id, title: 'Synthetic observed Tools task', status: 'in_progress' });
      db.prepare('UPDATE space_tasks SET post_approval_session_id=? WHERE id=?').run(sessionId, task.id);
      const data = agent.getSessionData();
      data.type = 'worker';
      data.context = { spaceId: space.id, taskId: task.id };
      data.metadata = { ...data.metadata, promptProvenance: { nodeId: 'synthetic-node', agentName: 'Coder' } };
      await app.db.updateSession(sessionId, { type: data.type, context: data.context, metadata: data.metadata });
      panelPath = `/space/${space.id}/task/${task.id}`;
      evidence.taskFixture = { spaceId: space.id, taskId: task.id, sessionId, dispatchStopped: true };
    }
    const { Hono } = await import(Bun.resolveSync('hono', resolve(import.meta.dir, '../../../packages/cli')));
    const { serveStatic } = await import(Bun.resolveSync('hono/bun', resolve(import.meta.dir, '../../../packages/cli')));
    const { createWebSocketHandlers } = await import('../../../packages/daemon/src/routes/setup-websocket.ts');
    const dist = resolve(import.meta.dir, '../../../packages/web/dist');
    const web = new Hono();
    web.use('/*', serveStatic({ root: dist }));
    web.get('*', async c => c.html(await Bun.file(join(dist, 'index.html')).text()));
    preview = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request, server) => {
      const refused = app.guardRequest(request);
      if (refused) return refused;
      if (new URL(request.url).pathname === '/ws') {
        const device = await app.authenticateUpgrade(request, server.requestIP(request)?.address ?? null);
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      return web.fetch(request);
    }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
    console.log(`PANEL: http://127.0.0.1:${preview.port}${panelPath} PID=${process.pid}`);
    await new Promise<void>(done => process.once('SIGTERM', done));
    evidence.panelAwaitedManualInspection = true;
  } else {
  queries[0].status = async () => { throw new Error('secret failure'); };
  evidence.failed = await inventory();
  assert.equal((evidence.failed as SessionToolInventory).mcpServers[0].status, 'unverified');
  const late = deferred<unknown[]>();
  settleLateStatus = () => late.resolve([]);
  queries[0].status = () => late.promise;
  const oldRead = inventory();
  void oldRead.catch(() => {});
  await new Promise(done => setTimeout(done, 50));
  queries[0].finish.resolve();
  await until(() => !app.sessionManager.getSession(sessionId)?.queryObject, 'query did not finish');
  await hub.request('message.send', { sessionId, content: 'Distinct later human input' });
  let choiceId = '';
  await until(async () => {
    const page = await hub.request<{ sdkMessages: Array<{ type: string; action?: string; uuid?: string }> }>('message.sdkMessages', { sessionId });
    choiceId = page.sdkMessages.find(message => message.action === 'sdk_resume_choice')?.uuid ?? '';
    return !!choiceId;
  }, 'synthetic missing-transcript choice did not appear');
  evidence.resumeChoice = await hub.request('session.sdkResumeChoice', { sessionId, choice: 'start_fresh', messageUuid: choiceId });
  await until(() => queries.length === 2, 'replacement query did not start');
  await until(async () => (await inventory()).state === 'observed', 'replacement init not observed');
  late.resolve([{ name: 'stale', status: 'connected', tools: [{ name: 'old' }] }]);
  const replaced = await oldRead;
  evidence.replaced = replaced;
  assert(replaced.tools.includes('mcp__browser__navigate2'));
  assert(!replaced.mcpServers.some(server => server.name === 'stale'));
  await transport.close();
  const reconnected = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  const newHub = new MessageHub({ defaultSessionId: 'global' });
  newHub.registerTransport(reconnected);
  try {
    await reconnected.initialize();
    evidence.reconnected = await newHub.request('session.getToolInventory', { sessionId });
    assert.deepEqual(evidence.reconnected, await app.sessionManager.getSession(sessionId)!.getToolInventory());
    queries[1].finish.resolve();
    await until(() => !app.sessionManager.getSession(sessionId)?.queryObject, 'replacement did not finish');
    evidence.ended = await newHub.request('session.getToolInventory', { sessionId });
    assert.equal((evidence.ended as SessionToolInventory).state, 'not_running');
    await app.sessionManager.interruptInMemorySession(sessionId);
    evidence.reloaded = await newHub.request('session.getToolInventory', { sessionId });
    assert.equal((evidence.reloaded as SessionToolInventory).state, 'not_running');
    assert.equal(queries.length, 2);
    const agent = app.sessionManager.getSession(sessionId)!;
    agent.getSessionData().config.provider = 'acp';
    evidence.acp = await newHub.request('session.getToolInventory', { sessionId });
    assert.equal((evidence.acp as SessionToolInventory).state, 'unverified');
    assert.deepEqual((evidence.acp as SessionToolInventory).tools, []);
  } finally { await reconnected.close(); }
  evidence.pass = true;
  console.log(`PASS actual isolated-daemon inventory RPC: ${join(run, 'evidence/live-inventory.json')}`);
  }
} finally {
  preview?.stop(true);
  settleLateStatus();
  evidence.finalQueryCount = queries.length;
  for (const query of queries) query.finish.resolve();
  await transport.close();
  await app.cleanup();
  await mcpClient.close();
  await mcp.close();
  writeFileSync(join(run, 'evidence/live-inventory.json'), JSON.stringify(evidence, null, 2));
}
