import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session, AppSkill } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { Database } = await import('../../../packages/daemon/src/storage/index.ts');
const { noOpReactiveDb } = await import('../../../packages/daemon/tests/helpers/reactive-database.ts');
const { SpaceRepository } = await import('../../../packages/daemon/src/storage/repositories/space-repository.ts');
const seed = new Database(join(run, 'data/daemon.db'));
await seed.initialize(noOpReactiveDb);
let serverId = '';
let skillId = '';
let spaceId = '';
const ids = ['legacy-on', 'legacy-veto', 'legacy-space-off', 'legacy-session-on'];
try {
  const server = seed.appMcpServers.create({ name: 'fixture-registry', sourceType: 'stdio', command: 'not-executed', enabled: true });
  serverId = server.id;
  skillId = crypto.randomUUID();
  const skill: AppSkill = { id: skillId, name: 'fixture-alias', displayName: 'Fixture', description: '', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: serverId }, enabled: true, builtIn: false, validationStatus: 'valid', createdAt: 1 };
  seed.skills.insert(skill);
  spaceId = new SpaceRepository(seed.getDatabase()).createSpace({ name: 'Synthetic Space', slug: 'synthetic-space', workspacePath: join(run, 'workspace') }).id;
  seed.mcpEnablement.setOverride('space', spaceId, serverId, false);
  seed.mcpEnablement.setOverride('session', ids[3], serverId, true);
  for (const [index, id] of ids.entries()) {
    const now = new Date().toISOString();
    await seed.createSession({ id, title: id, workspacePath: join(run, 'workspace'), createdAt: now, lastActiveAt: now, status: 'paused', config: { model: 'haiku', maxTokens: 8192, temperature: 1, queryMode: 'manual', tools: { disabledSkills: index === 1 ? [skillId] : [] }, sdkToolsPreset: ['Read'] }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 }, ...(index >= 2 ? {context: {spaceId}} : {}) }, { enforceWorkspaceOwnership: false });
  }
  seed.getDatabase().prepare('INSERT INTO sessions (id,title,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?)').run('corrupt-config', 'Synthetic corrupt row', new Date().toISOString(), new Date().toISOString(), 'paused', '{broken', '{}');
} finally { await seed.close(); }
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const evidence: Record<string, unknown> = { providerTurns: 0, canonicalActivationVerified: false, panelVerified: false };
let prior: unknown;
for (const boot of [1, 2]) {
  const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  try {
    await transport.initialize();
    assert.deepEqual(app.db.getDatabase().prepare('SELECT config FROM sessions WHERE id=?').get('corrupt-config'), { config: '{broken' });
    evidence.corruptRowDoesNotBlockStartup = true;
    const sessions: Session[] = [];
    for (const sessionId of ids) sessions.push((await hub.request<{session: Session}>('session.get', {sessionId})).session);
    const snapshots = sessions.map(session => session.config.toolSelection);
    assert.deepEqual(snapshots.map(snapshot => snapshot?.choices[`mcp:${serverId}`]?.selected), [true, false, false, true]);
    assert(snapshots.every(snapshot => snapshot?.version === 1));
    assert(snapshots.every(snapshot => snapshot?.choices[`mcp:${serverId}`]?.aliases?.[0] === 'fixture-alias'));
    assert(sessions.every(session => JSON.stringify(session.config.sdkToolsPreset) === '["Read"]'));
    const defaults = app.db.getGlobalSettings().toolSelectionDefaults;
    assert.equal(defaults?.choices[`mcp:${serverId}`]?.selected, true);
    const spaceDefaults = new SpaceRepository(app.db.getDatabase()).getSpace(spaceId)?.config?.toolSelectionDefaults;
    assert.equal(spaceDefaults?.choices[`mcp:${serverId}`]?.selected, false);
    evidence[`boot${boot}`] = { snapshots, globalDefault: defaults?.choices[`mcp:${serverId}`], spaceDefault: spaceDefaults?.choices[`mcp:${serverId}`] };
    if (boot === 1) {
      prior = snapshots;
      await hub.request('session.update', { sessionId: ids[0], config: { ...sessions[0].config, autoScroll: false } });
      const echoed = (await hub.request<{session: Session}>('session.get', {sessionId: ids[0]})).session;
      assert.equal(echoed.config.autoScroll, false);
      assert.deepEqual(echoed.config.toolSelection, snapshots[0]);
      evidence.unchangedSelectionEchoAllowed = true;
      await assert.rejects(hub.request('session.update', { sessionId: ids[0], config: { toolSelection: { version: 1, choices: {} } } }), /does not accept config field\(s\): toolSelection/);
      evidence.ordinarySettingsCannotReplaceSelection = true;
      const updatedSpace = await hub.request<{ config: { toolSelectionDefaults?: unknown }; maxConcurrentTasks: number }>('space.update', { id: spaceId, config: { maxConcurrentTasks: 5 } });
      assert.deepEqual(updatedSpace.config.toolSelectionDefaults, spaceDefaults);
      assert.equal(updatedSpace.maxConcurrentTasks, 5);
      await hub.request('settings.global.update', { updates: { autoScroll: false } });
      assert.deepEqual(app.db.getGlobalSettings().toolSelectionDefaults, defaults);
      for (const [method, params] of [
        ['space.update', { id: spaceId, config: { toolSelectionDefaults: { version: 1, choices: {} } } }],
        ['space.create', { name: 'Injected', workspacePath: join(run, 'injected'), config: { toolSelectionDefaults: { version: 1, choices: {} } } }],
        ['settings.global.update', { updates: { toolSelectionDefaults: { version: 1, choices: {} } } }],
      ] as const) await assert.rejects(hub.request(method, params), /toolSelectionDefaults.*daemon/);
      evidence.ordinarySettingsPreserveDefaults = true;
      const repairRepo = new SpaceRepository(app.db.getDatabase());
      const repairSpace = repairRepo.createSpace({ name: 'Synthetic config repair', slug: 'synthetic-config-repair', workspacePath: join(run, 'repair-workspace') });
      app.db.getDatabase().prepare('UPDATE spaces SET config=? WHERE id=?').run('{broken', repairSpace.id);
      const repaired = repairRepo.updateSpace(repairSpace.id, { config: { maxConcurrentTasks: 5 } });
      assert.deepEqual(repaired?.config, { maxConcurrentTasks: 5 });
      assert.deepEqual(repairRepo.getSpace(repairSpace.id)?.config, { maxConcurrentTasks: 5 });
      evidence.repositoryCanReplaceMalformedSpaceConfig = true;
      await hub.request('skill.setEnabled', { id: skillId, enabled: false });
      await hub.request('mcp.registry.setEnabled', { id: serverId, enabled: false });
    } else assert.deepEqual(snapshots, prior);
  } finally { await transport.close(); await app.cleanup(); }
}
evidence.pass = true;
writeFileSync(join(run, 'evidence/session-tool-migration.json'), JSON.stringify(evidence, null, 2));
console.log('PASS startup migration: four legacy sessions retain choices and aliases over two daemon boots despite catalog edits');
