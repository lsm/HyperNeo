import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { AppMcpServer, AppSkill, Session } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';

const run = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--'))!);
const baseline = process.argv.includes('--baseline');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
for (const [name, body] of [['gh', 'exit 1'], ['claude', 'printf "[]\\n"']]) writeFileSync(join(run, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No external HTTP in catalog proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let preview: ReturnType<typeof Bun.serve> | undefined;
const evidence: Record<string, unknown> = { pass: false, baseline, providerTurns: 0 };
try {
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.create', { name: 'Fixture Server', sourceType: 'stdio', command: 'never-executed', enabled: false });
  const { skill } = await hub.request<{ skill: AppSkill }>('skill.create', { params: { name: 'fixture-guide', displayName: 'Fixture Guide', description: 'Synthetic default fixture', sourceType: 'builtin', config: { type: 'builtin', commandName: 'fixture-guide' }, enabled: false, validationStatus: 'valid' } });
  const defaults = { version: 1 as const, choices: { [`mcp:${server.id}`]: { selected: true }, [`skill:${skill.id}`]: { selected: true } } };
  app.db.updateGlobalSettings({ toolSelectionDefaults: defaults });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { title: 'Frozen default fixture', workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' } });
  const frozen = (await hub.request<{ session: Session }>('session.get', { sessionId })).session.config.toolSelection;
  evidence.initial = { defaults, server, skill, frozen };
  const { Hono } = await import(Bun.resolveSync('hono', resolve(import.meta.dir, '../../../packages/cli')));
  const { serveStatic } = await import(Bun.resolveSync('hono/bun', resolve(import.meta.dir, '../../../packages/cli')));
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
  console.log(`CATALOG: http://127.0.0.1:${preview.port}/settings?tab=app-mcp-servers PID=${process.pid}`);
  await new Promise<void>(done => process.once('SIGUSR1', done));
  const saved = app.db.getGlobalSettings().toolSelectionDefaults;
  const after = (await hub.request<{ session: Session }>('session.get', { sessionId })).session.config.toolSelection;
  evidence.final = { defaults: saved, frozen: after, servers: await hub.request('mcp.registry.list', {}), skills: app.skillsManager.listSkills() };
  assert.deepEqual(after, frozen);
  if (!baseline) {
    assert.equal(saved?.choices[`mcp:${server.id}`]?.selected, false);
    assert.equal(saved?.choices[`skill:${skill.id}`]?.selected, false);
    evidence.pass = true;
  }
  console.log(baseline ? 'BASELINE: retain browser mismatch evidence' : 'PASS: catalog edits persisted both defaults off; existing session choices stayed frozen');
} finally {
  preview?.stop(true);
  await transport?.close();
  await app?.cleanup();
  globalThis.fetch = network;
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/catalog-tool-defaults.json'), JSON.stringify(evidence, null, 2));
}
