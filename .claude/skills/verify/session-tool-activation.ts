import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { mock } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AppMcpServer, AppSkill, Session } from '../../../packages/shared/src/mod.ts';
import type { SessionToolSelection } from '../../../packages/shared/src/types/session-tool-choice.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { Server } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { ListToolsRequestSchema } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

const run = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--'))!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['workspace', 'bin', 'evidence', 'fixture-plugin/.claude-plugin']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'fixture-plugin/.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }));
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const mcp = new Server({ name: 'synthetic-browser', version: '1' }, { capabilities: { tools: {} } });
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'navigate', inputSchema: { type: 'object' } }] }));
const client = new Client({ name: 'scripted-sdk', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await mcp.connect(a); await client.connect(b);
let interrupts = 0;
const discoveryProbes = { created: 0, interrupted: 0 };
const interruptOrigins: string[] = [];
const queryOrigins: string[] = [];
let statusFails = false;
let initialReplyHandled = false;
const applications: string[][] = [];
const queries: Array<{ aliases: string[]; allNames: string[]; plugins: string[]; tools: unknown; finish: () => void }> = [];
const sdk = await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ prompt, options }: { prompt: AsyncIterable<unknown> | string; options: Options }) => {
  let finish!: () => void;
  const ended = new Promise<void>(done => { finish = done; });
  const allNames = Object.keys(options.mcpServers ?? {});
  const aliases = Object.entries(options.mcpServers ?? {}).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
  const plugins = (options.plugins ?? []).map(plugin => basename(plugin.path));
  const discovery = typeof prompt === 'string' && options.maxTurns === 0;
  if (discovery) discoveryProbes.created++;
  else queries.push({ aliases, allNames, plugins, tools: options.tools, finish });
  queryOrigins.push(new Error('Synthetic query created').stack ?? '');
  return {
    async *[Symbol.asyncIterator]() {
      assert.notEqual(typeof prompt, 'string');
      const feed = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator](); await feed.next(); void feed.next().catch(() => {});
      yield { type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: crypto.randomUUID(), cwd: join(run, 'workspace'), model: 'claude-haiku-4-5-20251001', permissionMode: 'default', apiKeySource: 'user', claude_code_version: 'scripted', tools: ['Read', ...aliases.map(name => `mcp__${name}__navigate`)], skills: [], plugins: (options.plugins ?? []).map(plugin => ({ name: basename(plugin.path), path: plugin.path })), mcp_servers: aliases.map(name => ({ name, status: 'connected' })), slash_commands: [], output_style: 'default' };
      yield { type: 'assistant', uuid: crypto.randomUUID(), session_id: crypto.randomUUID(), parent_tool_use_id: null,
        message: { id: crypto.randomUUID(), type: 'message', role: 'assistant', content: [{type: 'text', text: 'Synthetic session ready for tool choices.'}], model: 'claude-haiku-4-5-20251001', stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1} } };
      initialReplyHandled = true;
      await ended;
    },
    close: finish, interrupt: async () => { if (discovery) discoveryProbes.interrupted++; else interrupts++; interruptOrigins.push(new Error('Synthetic interrupt').stack ?? ''); finish(); }, supportedModels: async () => [], supportedCommands: async () => [], setPermissionMode: async () => {},
    setMcpServers: async (servers: NonNullable<Options['mcpServers']>) => {
      const prior = [...aliases];
      const next = Object.entries(servers).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
      aliases.splice(0, aliases.length, ...next); applications.push([...next]);
      return { added: next.filter(name => !prior.includes(name)), removed: prior.filter(name => !next.includes(name)), errors: {} };
    },
    mcpServerStatus: async () => {
      if (statusFails) throw new Error('Synthetic status read failure');
      return Promise.all(aliases.map(async name => ({ name, status: 'connected', tools: (await client.listTools()).tools })));
    },
  };
} }));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
let preview: ReturnType<typeof Bun.serve> | undefined;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No external HTTP in canonical SDK proof'); }) as typeof fetch;
const evidence: Record<string, unknown> = { pass: false, cases: [], scriptedSDK: true, realProvider: false, browserExecutionVerified: false, liveActivationWired: true, panelVerified: false };
try {
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport); await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'synthetic-never-sent' } });
  const initial = await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {});
  for (const server of initial.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.create', { name: 'fixture-registry', sourceType: 'stdio', command: 'not-executed', enabled: false });
  const createSkill = async (params: unknown) => (await hub.request<{ skill: AppSkill }>('skill.create', { params })).skill;
  const wrapper = await createSkill({ name: 'fixture-wrapper', displayName: 'Browser', description: 'Synthetic', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: server.id }, enabled: false, validationStatus: 'valid' });
  const guide = await createSkill({ name: 'fixture-guide', displayName: 'Guide', description: 'Synthetic', sourceType: 'builtin', config: { type: 'builtin', commandName: 'fixture-guide' }, enabled: false, validationStatus: 'valid' });
  const plugin = await createSkill({ name: 'fixture-plugin', displayName: 'Plugin', description: 'Synthetic', sourceType: 'plugin', config: { type: 'plugin', pluginPath: join(run, 'fixture-plugin') }, enabled: false, validationStatus: 'valid' });
  mkdirSync(join(run, 'data/skills/fixture-guide'), { recursive: true });
  writeFileSync(join(run, 'data/skills/fixture-guide/SKILL.md'), '---\nname: fixture-guide\ndescription: Synthetic instructions\n---\nUse the synthetic fixture.\n');
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { title: 'Synthetic tools', workspacePath: join(run, 'workspace'), config: { model: 'haiku', provider: 'anthropic', sdkToolsPreset: ['Read'] } });
  const session = (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  const aliases = session.config.toolSelection!.choices[`mcp:${server.id}`]!.aliases!;
  await hub.request('message.send', { sessionId, content: 'Use my tools' });
  const deadline = Date.now() + 15000;
  while ((await hub.request<{ state: string }>('session.getToolInventory', { sessionId })).state !== 'observed' || !initialReplyHandled) {
    assert(Date.now() < deadline, 'query init missing'); await new Promise(done => setTimeout(done, 25));
  }
  assert.equal(queries.length, 1); assert.deepEqual(queries[0].aliases, []);
  const initialPlugins = [...queries[0].plugins];
  const choose = async (id: string, key: string, selected: boolean) => {
    const result = await hub.request<{ ok: boolean; application: string; reason?: string }>('operation.invoke', { name: 'session.tools.setChoice', input: { sessionId: id, key, selected } });
    assert(result.ok, `authorized tool activation must persist a choice: ${JSON.stringify(result)}`); return result;
  };
  const taskPanel = process.argv.includes('--show-task-panel') || process.argv.includes('--show-task-panel-before');
  const baselinePanel = process.argv.includes('--show-panel-before') || process.argv.includes('--show-task-panel-before');
  if (process.argv.includes('--show-panel') || baselinePanel || taskPanel) {
    let panelPath = `/session/${sessionId}`;
    if (taskPanel) {
      await app.jobProcessor.stop();
      const { SpaceRepository } = await import('../../../packages/daemon/src/storage/repositories/space-repository.ts');
      const { SpaceTaskRepository } = await import('../../../packages/daemon/src/storage/repositories/space-task-repository.ts');
      const db = app.db.getDatabase();
      const space = new SpaceRepository(db).createSpace({name:'Synthetic activation Space',slug:'synthetic-activation',workspacePath:join(run,'workspace')});
      const task = new SpaceTaskRepository(db).createTask({spaceId:space.id,title:'Synthetic tool activation task',status:'in_progress'});
      db.prepare('UPDATE space_tasks SET post_approval_session_id=? WHERE id=?').run(sessionId,task.id);
      const data = app.sessionManager.getSession(sessionId)!.getSessionData();
      data.type = 'worker'; data.context = {spaceId:space.id,taskId:task.id};
      data.metadata = {...data.metadata,promptProvenance:{nodeId:'synthetic-node',agentName:'Coder'}};
      await app.db.updateSession(sessionId,{type:data.type,context:data.context,metadata:data.metadata});
      panelPath = `/space/${space.id}/task/${task.id}`;
      evidence.taskFixture = {spaceId:space.id,taskId:task.id,sessionId,dispatchStopped:true};
    }
    const { Hono } = await import(Bun.resolveSync('hono', resolve(import.meta.dir, '../../../packages/cli')));
    const { serveStatic } = await import(Bun.resolveSync('hono/bun', resolve(import.meta.dir, '../../../packages/cli')));
    const { createWebSocketHandlers } = await import('../../../packages/daemon/src/routes/setup-websocket.ts');
    const dist = resolve(import.meta.dir, '../../../packages/web/dist');
    const web = new Hono();
    web.use('/*', serveStatic({ root: dist }));
    web.get('*', async c => c.html(await Bun.file(join(dist, 'index.html')).text()));
    const owned = app;
    preview = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request, server) => {
      const refused = owned.guardRequest(request);
      if (refused) return refused;
      if (new URL(request.url).pathname === '/ws') {
        const device = await owned.authenticateUpgrade(request, server.requestIP(request)?.address ?? null);
        if (server.upgrade(request, { data: { connectionSessionId: 'global', device } })) return;
        return new Response('Upgrade failed', { status: 500 });
      }
      return web.fetch(request);
    }, websocket: createWebSocketHandlers(owned.transport, owned.sessionManager) });
    console.log(`PANEL: http://127.0.0.1:${preview.port}${panelPath} PID=${process.pid}`);
    await new Promise<void>(done => process.once('SIGUSR1', done));
    evidence.panel = { applications, interrupts, discoveryProbes, interruptOrigins, queryOrigins, workerQueryCount: queries.length, session: (await hub.request<{session: Session}>('session.get', {sessionId})).session.config.toolSelection, inventory: await hub.request('session.getToolInventory', {sessionId}) };
    assert.equal(interrupts, 0); assert.equal(queries.length, 1);
    if (!baselinePanel) {
      assert(applications.some(names => names.includes(aliases[0])));
      assert(applications.some(names => names.length === 0));
      assert.equal((evidence.panel as {session: SessionToolSelection}).session.choices[`skill:${guide.id}`]?.selected, true);
    }
    evidence.panelVerified = !baselinePanel;
    evidence.panelSurface = taskPanel ? 'space-task' : 'session';
    evidence.pass = true;
  } else {
  const enabled = await choose(sessionId, `mcp:${server.id}`, true);
  assert.equal(enabled.application, 'live'); assert.deepEqual(queries[0].aliases, aliases);
  const observed = await hub.request<{ mcpServers: Array<{ name: string; tools: string[] }>; plugins: string[]; tools: string[] }>('session.getToolInventory', { sessionId });
  assert.deepEqual(observed.mcpServers.map(server => server.name), aliases);
  assert.deepEqual(observed.mcpServers[0].tools, ['navigate']);
  assert.deepEqual(observed.tools, ['Read', ...aliases.map(name => `mcp__${name}__navigate`)]);
  statusFails = true;
  const unavailable = await hub.request<{ mcpServers: Array<{ name: string; status: string; tools: string[] | null }>; tools: string[] }>('session.getToolInventory', { sessionId });
  evidence.unavailable = unavailable;
  assert.deepEqual(unavailable.mcpServers, aliases.map(name => ({ name, status: 'unverified', tools: null })));
  assert.deepEqual(unavailable.tools, observed.tools);
  statusFails = false;
  const recovered = await hub.request<typeof observed>('session.getToolInventory', { sessionId });
  assert.deepEqual(recovered, observed);
  const disabled = await choose(sessionId, `mcp:${server.id}`, false);
  assert.equal(disabled.application, 'live'); assert.deepEqual(queries[0].aliases, []);
  assert.deepEqual((await hub.request<{ tools: string[] }>('session.getToolInventory', { sessionId })).tools, ['Read']);
  const instructions = await choose(sessionId, `skill:${guide.id}`, true);
  assert.equal(instructions.application, 'restart_required');
  assert.deepEqual(queries[0].plugins, initialPlugins);
  assert(!queries[0].plugins.includes('fixture-guide'));
  const { sessionId: coldId } = await hub.request<{ sessionId: string }>('session.create', { title: 'Synthetic tools', workspacePath: join(run, 'workspace'), config: { model: 'haiku', provider: 'anthropic' } });
  const cold = await choose(coldId, `mcp:${server.id}`, true);
  assert.equal(cold.application, 'next_query'); assert.equal(queries.length, 1); assert.equal(interrupts, 0);
  evidence.results = { initialPlugins, enabled, disabled, instructions, cold, observed, unavailable, recovered, applications, interrupts, queryCount: queries.length };
  evidence.pass = true; console.log('PASS: public tool activation applies live MCP choices and verifies observed tools; instructions disclose restart, cold choices wait, no automatic interrupt');
  }
} finally {
  preview?.stop(true);
  for (const query of queries) query.finish();
  await transport?.close(); await app?.cleanup(); await client.close(); await mcp.close(); globalThis.fetch = network;
  evidence.resourcesStopped = true;
  evidence.discoveryProbes = discoveryProbes;
  writeFileSync(join(run, 'evidence/session-tool-activation.json'), JSON.stringify(evidence, null, 2));
}
