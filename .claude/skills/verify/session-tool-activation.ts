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
let interrupts = 0;
const applications: string[][] = [];
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
    close: finish, interrupt: async () => { interrupts++; finish(); }, supportedModels: async () => [], supportedCommands: async () => [], setPermissionMode: async () => {},
    setMcpServers: async (servers: NonNullable<Options['mcpServers']>) => {
      const prior = [...aliases];
      const next = Object.entries(servers).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
      aliases.splice(0, aliases.length, ...next); applications.push([...next]);
      return { added: next.filter(name => !prior.includes(name)), removed: prior.filter(name => !next.includes(name)), errors: {} };
    },
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
  while ((await hub.request<{ state: string }>('session.getToolInventory', { sessionId })).state !== 'observed') {
    assert(Date.now() < deadline, 'query init missing'); await new Promise(done => setTimeout(done, 25));
  }
  assert.equal(queries.length, 1); assert.deepEqual(queries[0].aliases, []);
  const choose = async (id: string, key: string, selected: boolean) => {
    const result = await hub.request<{ kind: string; value?: { ok: boolean; application: string; reason?: string } }>('operation.invoke', { name: 'session.tools.setChoice', input: { sessionId: id, key, selected } });
    assert.equal(result.kind, 'completed', 'authorized tool activation operation must exist'); assert(result.value?.ok); return result.value;
  };
  const enabled = await choose(sessionId, `mcp:${server.id}`, true);
  assert.equal(enabled.application, 'live'); assert.deepEqual(queries[0].aliases, aliases);
  const observed = await hub.request<{ mcpServers: Array<{ name: string; tools: string[] }>; plugins: string[] }>('session.getToolInventory', { sessionId });
  assert.deepEqual(observed.mcpServers.map(server => server.name), aliases);
  assert.deepEqual(observed.mcpServers[0].tools, ['navigate']);
  const disabled = await choose(sessionId, `mcp:${server.id}`, false);
  assert.equal(disabled.application, 'live'); assert.deepEqual(queries[0].aliases, []);
  const instructions = await choose(sessionId, `skill:${guide.id}`, true);
  assert.equal(instructions.application, 'restart_required');
  assert.deepEqual(queries[0].plugins, []);
  const { sessionId: coldId } = await hub.request<{ sessionId: string }>('session.create', { title: 'Synthetic tools', workspacePath: join(run, 'workspace'), config: { model: 'haiku', provider: 'anthropic' } });
  const cold = await choose(coldId, `mcp:${server.id}`, true);
  assert.equal(cold.application, 'next_query'); assert.equal(queries.length, 1); assert.equal(interrupts, 0);
  evidence.results = { enabled, disabled, instructions, cold, observed, applications, interrupts, queryCount: queries.length };
  evidence.pass = true; console.log('PASS: public tool activation applies live MCP choices and verifies observed tools; instructions disclose restart, cold choices wait, no automatic interrupt');
} finally {
  for (const query of queries) query.finish();
  await transport?.close(); await app?.cleanup(); await client.close(); await mcp.close(); globalThis.fetch = network;
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/session-tool-activation.json'), JSON.stringify(evidence, null, 2));
}
