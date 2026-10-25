import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import type { AppMcpServer, AppSkill, McpEnablementOverride } from '../../../packages/shared/src/mod.ts';
import { projectLegacySessionToolSelection, resolveSessionToolChoices } from '../../../packages/daemon/src/lib/tools/session-tool-choice.ts';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { Server } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { ListToolsRequestSchema } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const mcp = new Server({ name: 'synthetic-browser', version: '1' }, { capabilities: { tools: {} } });
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'navigate', inputSchema: { type: 'object' } }] }));
const client = new Client({ name: 'synthetic-sdk', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await mcp.connect(a);
await client.connect(b);
const queries: Array<{ aliases: string[]; finish: () => void }> = [];
const sdk = await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { mcpServers?: Record<string, unknown> } }) => {
  let finish!: () => void;
  const ended = new Promise<void>(done => { finish = done; });
  const aliases = Object.keys(options.mcpServers ?? {}).filter(name => name.startsWith('fixture-'));
  queries.push({ aliases, finish });
  return {
    async *[Symbol.asyncIterator]() {
      const feed = prompt[Symbol.asyncIterator]();
      await feed.next();
      void feed.next().catch(() => {});
      yield { type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: crypto.randomUUID(), cwd: join(run, 'workspace'), model: 'claude-haiku-4-5-20251001', permissionMode: 'default', apiKeySource: 'user', claude_code_version: 'synthetic', tools: aliases.map(name => `mcp__${name}__navigate`), skills: [], plugins: [], mcp_servers: aliases.map(name => ({ name, status: 'connected' })), slash_commands: [], output_style: 'default' };
      await ended;
    },
    close: finish,
    interrupt: async () => finish(),
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setPermissionMode: async () => {},
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    mcpServerStatus: async () => Promise.all(aliases.map(async name => ({ name, status: 'connected', tools: (await client.listTools()).tools }))),
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
const evidence: Record<string, unknown> = { cases: [], canonicalWiringVerified: false, panelVerified: false };
try {
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'synthetic-never-sent' } });
  const initial = await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {});
  for (const server of initial.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.create', { name: 'fixture-registry-name', sourceType: 'stdio', command: 'not-executed', enabled: true });
  let { skill } = await hub.request<{ skill: AppSkill }>('skill.create', { params: { name: 'fixture-wrapper-alias', displayName: 'Synthetic browser', description: 'Synthetic fixture', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: server.id }, enabled: false, validationStatus: 'valid' } });
  for (const name of ['server-on-wrapper-off', 'wrapper-on', 'session-veto', 'session-server-off']) {
    if (name === 'wrapper-on') ({ skill } = await hub.request<{ skill: AppSkill }>('skill.setEnabled', { id: skill.id, enabled: true }));
    const disabledSkills = name === 'session-veto' ? [skill.id] : [];
    const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: name, config: { model: 'haiku', provider: 'anthropic', tools: { disabledSkills } } });
    const overrides: McpEnablementOverride[] = name === 'session-server-off' ? [{ scopeType: 'session', scopeId: sessionId, serverId: server.id, enabled: false }] : [];
    for (const override of overrides) await hub.request('mcp.enablement.setOverride', override);
    const input = { session: { id: sessionId }, skills: [skill], registry: [server], overrides, disabledSkillIds: disabledSkills };
    const snapshot = projectLegacySessionToolSelection(input);
    const resolved = resolveSessionToolChoices(input, snapshot);
    const expected = resolved.filter(choice => choice.selected).flatMap(choice => choice.aliases);
    const before = queries.length;
    await hub.request('message.send', { sessionId, content: 'Synthetic human asks to use browser' });
    let observed: { state: string; mcpServers: Array<{ name: string; status: string; tools: string[] }> } | undefined;
    const deadline = Date.now() + 15000;
    do {
      observed = await hub.request('session.getToolInventory', { sessionId });
      if (observed?.state === 'observed') break;
      assert(Date.now() < deadline, `${name}: init missing`);
      await new Promise(done => setTimeout(done, 25));
    } while (true);
    assert.equal(queries.length, before + 1);
    assert.deepEqual(queries[before].aliases, expected);
    assert.deepEqual(observed.mcpServers.map(entry => entry.name), expected);
    for (const entry of observed.mcpServers) assert.deepEqual(entry.tools, ['navigate']);
    assert.equal(resolved[0].selected, name === 'wrapper-on');
    (evidence.cases as unknown[]).push({ name, snapshot, resolved, sdkAliases: queries[before].aliases, observed });
    queries[before].finish();
  }
  evidence.pass = true;
  console.log('PASS legacy projection matches actual SDK options and inventory in four isolated daemon sessions');
} finally {
  for (const query of queries) query.finish();
  await transport.close();
  await app.cleanup();
  await client.close();
  await mcp.close();
  writeFileSync(join(run, 'evidence/session-tool-choice.json'), JSON.stringify(evidence, null, 2));
}
