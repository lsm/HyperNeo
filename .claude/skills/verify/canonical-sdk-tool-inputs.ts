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

const run = resolve(process.argv[2]);
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
const queries: Array<{ aliases: string[]; allNames: string[]; plugins: string[]; tools: unknown; finish: () => void }> = [];
const sdk = await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
  let finish!: () => void;
  const ended = new Promise<void>(done => { finish = done; });
  const allNames = Object.keys(options.mcpServers ?? {});
  const aliases = Object.entries(options.mcpServers ?? {}).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
  const plugins = (options.plugins ?? []).map(plugin => basename(plugin.path));
  queries.push({ aliases, allNames, plugins, tools: options.tools, finish });
  return {
    async *[Symbol.asyncIterator]() {
      const feed = prompt[Symbol.asyncIterator](); await feed.next(); void feed.next().catch(() => {});
      yield { type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: crypto.randomUUID(), cwd: join(run, 'workspace'), model: 'claude-haiku-4-5-20251001', permissionMode: 'default', apiKeySource: 'user', claude_code_version: 'scripted', tools: aliases.map(name => `mcp__${name}__navigate`), skills: [], plugins: (options.plugins ?? []).map(plugin => ({ name: basename(plugin.path), path: plugin.path })), mcp_servers: aliases.map(name => ({ name, status: 'connected' })), slash_commands: [], output_style: 'default' };
      await ended;
    },
    close: finish, interrupt: async () => finish(), supportedModels: async () => [], supportedCommands: async () => [], setPermissionMode: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    mcpServerStatus: async () => Promise.all(aliases.map(async name => ({ name, status: 'connected', tools: (await client.listTools()).tools }))),
  };
} }));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No external HTTP in canonical SDK proof'); }) as typeof fetch;
const evidence: Record<string, unknown> = { pass: false, cases: [], scriptedSDK: true, realProvider: false, browserExecutionVerified: false, liveActivationWired: false, panelVerified: false };
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
  for (const name of ['frozen-on', 'frozen-off', 'reserved-runtime', 'slot-veto']) {
    const on = name !== 'frozen-off';
    if (!on) {
      await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: true });
      for (const skill of [wrapper, guide, plugin]) await hub.request('skill.setEnabled', { id: skill.id, enabled: true });
    }
    const alias = name === 'reserved-runtime' ? 'hyperneo-operations' : 'frozen-browser';
    const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: name, config: { model: 'haiku', provider: 'anthropic', sdkToolsPreset: ['Read'], tools: { disabledSkills: on ? [wrapper.id, guide.id, plugin.id] : [] } } });
    const selection: SessionToolSelection = { version: 1, choices: { [`mcp:${server.id}`]: { selected: on, aliases: [alias] }, [`skill:${guide.id}`]: { selected: on }, [`skill:${plugin.id}`]: { selected: on } } };
    const snapshot = app.db.captureSessionRuntimeSettings(sessionId)!;
    assert.equal(await app.db.casSessionRuntimeSettings(snapshot, { toolSelection: selection }), 'won');
    await app.sessionManager.interruptInMemorySession(sessionId);
    const persisted = (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
    assert.deepEqual(persisted.config.toolSelection, selection);
    if (name === 'reserved-runtime') {
      const agent = await app.sessionManager.getSessionAsync(sessionId);
      assert(agent);
      agent.mergeRuntimeMcpServers({ 'runtime-fixture': { command: 'not-executed-runtime' } });
    }
    if (name === 'slot-veto') {
      const agent = await app.sessionManager.getSessionAsync(sessionId);
      assert(agent);
      agent.skillOverrides = [wrapper, guide, plugin].map(skill => ({ skillId: skill.id, enabled: false }));
    }
    const before = queries.length;
    await hub.request('message.send', { sessionId, content: 'Use my selected tools' });
    let observed: { state: string; mcpServers: Array<{ name: string; tools: string[] }> } | undefined;
    const deadline = Date.now() + 15000;
    do {
      observed = await hub.request('session.getToolInventory', { sessionId });
      if (observed?.state === 'observed') break;
      assert(Date.now() < deadline, `${name}: query init missing`); await new Promise(done => setTimeout(done, 25));
    } while (true);
    assert.equal(queries.length, before + 1);
    const query = queries[before];
    (evidence.cases as unknown[]).push({ name, selection, sdkAliases: query.aliases, sdkPlugins: query.plugins, nativeTools: query.tools, observed });
    const attached = on && name !== 'slot-veto';
    const expectedAliases = name === 'reserved-runtime' ? ['hyperneo-operations-2', 'runtime-fixture'] : attached ? ['frozen-browser'] : [];
    assert.deepEqual([...query.aliases].sort(), expectedAliases.sort());
    assert.deepEqual([...query.plugins].sort(), attached ? ['fixture-guide', 'fixture-plugin'] : []);
    assert.deepEqual(query.tools, ['Read']);
    assert(query.allNames.includes('hyperneo-operations'));
    assert.deepEqual(observed.mcpServers.map(entry => entry.name).sort(), [...query.aliases].sort());
    for (const entry of observed.mcpServers) assert.deepEqual(entry.tools, ['navigate']);
    query.finish();
  }
  evidence.pass = true; evidence.canonicalSdkConsumerWired = true;
  console.log('PASS: frozen MCP aliases and instruction plugins reach the scripted SDK and observed inventory; catalog flags do not override session choices');
} finally {
  for (const query of queries) query.finish();
  await transport?.close(); await app?.cleanup(); await client.close(); await mcp.close(); globalThis.fetch = network;
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/canonical-sdk-tool-inputs.json'), JSON.stringify(evidence, null, 2));
}
