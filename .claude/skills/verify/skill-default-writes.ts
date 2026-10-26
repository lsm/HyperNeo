import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppSkill, Session } from '../../../packages/shared/src/mod.ts';
import type { SessionToolSelection } from '../../../packages/shared/src/types/session-tool-choice.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = { skillDefaultCallerWired: true, importDefaultCallerWired: true, sdkConsumerWired: false, sdkApplyVerified: false, queryStarted: false };
let stopEvents = () => {};
const originalFetch = globalThis.fetch;
const installUrl = 'https://raw.githubusercontent.com/synthetic/fixture/main/SKILL.md';
let fetches = 0;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === installUrl) { fetches++; return Promise.resolve(new Response('# Synthetic skill\n\nFixture only.')); }
  return originalFetch(input, init);
}) as typeof fetch;
try {
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport); await transport.initialize();
  const raw = app.db.getDatabase();
  const { SpaceRepository } = await import('../../../packages/daemon/src/storage/repositories/space-repository.ts');
  const spaces = new SpaceRepository(raw);
  const space = spaces.createSpace({ slug: 'skills-fixture', name: 'Skills fixture', workspacePath: join(run, 'space') });
  const frozen: SessionToolSelection = { version: 1, choices: {} };
  raw.prepare("UPDATE global_settings SET settings=json_set(settings,'$.toolSelectionDefaults',json(?)) WHERE id=1").run(JSON.stringify(frozen));
  raw.prepare('UPDATE spaces SET config=?,stopped=1 WHERE id=?').run(JSON.stringify({ toolSelectionDefaults: frozen }), space.id);
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), config: { model: 'haiku', provider: 'anthropic', queryMode: 'manual', sdkToolsPreset: ['Read'] } });
  assert.equal(await app.db.casSessionRuntimeSettings(app.db.captureSessionRuntimeSettings(sessionId)!, { toolSelection: frozen }), 'won');
  const readDefault = (id?: string): SessionToolSelection => JSON.parse(String((id ? raw.prepare('SELECT config AS json FROM spaces WHERE id=?').get(id) : raw.prepare('SELECT settings AS json FROM global_settings WHERE id=1').get())!.json)).toolSelectionDefaults;
  const readChoice = (id: string, scoped = false) => readDefault(scoped ? space.id : undefined).choices[`skill:${id}`]?.selected;
  const params = { name: 'skill-rpc-fixture', displayName: 'Fixture', description: 'Synthetic', sourceType: 'builtin', config: { type: 'builtin', commandName: 'fixture' }, enabled: true };
  const { skill } = await hub.request<{ skill: AppSkill }>('skill.create', { params });
  assert.equal(readChoice(skill.id), true); assert.equal(readChoice(skill.id, true), true);
  await hub.request('skill.setEnabled', { id: skill.id, enabled: false }); assert.equal(readChoice(skill.id), false);
  await hub.request('skill.update', { id: skill.id, params: { enabled: true, config: { type: 'builtin', commandName: 'reworded-fixture' } } });
  assert.equal(readChoice(skill.id), true); assert.equal(readChoice(skill.id, true), true);
  evidence.skillCrudAndIntent = true;
  const { server: first } = await hub.request<{ server: { id: string } }>('mcp.registry.create', { name: 'skill-first', sourceType: 'stdio', command: 'not-executed', enabled: false });
  const { server: second } = await hub.request<{ server: { id: string } }>('mcp.registry.create', { name: 'skill-second', sourceType: 'stdio', command: 'not-executed', enabled: false });
  const { skill: wrapper } = await hub.request<{ skill: AppSkill }>('skill.create', { params: { ...params, name: 'binding-fixture', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: first.id }, enabled: false } });
  await Promise.all([
    hub.request('skill.update', { id: wrapper.id, params: { config: { type: 'mcp_server', appMcpServerId: second.id } } }),
    hub.request('skill.setEnabled', { id: wrapper.id, enabled: true }),
  ]);
  assert.equal(readDefault().choices[`mcp:${second.id}`].selected, true);
  assert.equal(readDefault().choices[`mcp:${first.id}`].selected, false);
  evidence.concurrentWrapperBinding = true;
  const { skill: staying } = await hub.request<{ skill: AppSkill }>('skill.create', { params: { ...params, name: 'staying-fixture', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: second.id }, enabled: true } });
  const { skill: off } = await hub.request<{ skill: AppSkill }>('skill.create', { params: { ...params, name: 'off-sibling', sourceType: 'mcp_server', config: { type: 'mcp_server', appMcpServerId: second.id }, enabled: false } });
  assert.equal(readDefault().choices[`mcp:${second.id}`].selected, true);
  await hub.request('skill.setEnabled', { id: wrapper.id, enabled: false });
  await hub.request('skill.delete', { id: off.id });
  assert.equal(readDefault().choices[`mcp:${second.id}`].selected, true);
  await hub.request('skill.update', { id: staying.id, params: { config: { type: 'mcp_server', appMcpServerId: first.id } } });
  for (const scope of [undefined, space.id]) {
    assert.equal(readDefault(scope).choices[`mcp:${second.id}`].selected, false);
    assert.equal(readDefault(scope).choices[`mcp:${first.id}`].selected, true);
  }
  await hub.request('skill.delete', { id: staying.id });
  assert.equal(readDefault().choices[`mcp:${first.id}`].selected, false);
  await hub.request('skill.setEnabled', { id: wrapper.id, enabled: true });
  evidence.wrapperRebindAndDelete = true; evidence.sharedWrapperDefault = true;
  let resolveSkills!: (rows: AppSkill[]) => void;
  let rejectSkills!: (error: Error) => void;
  const snapshot = new Promise<AppSkill[]>((resolve, reject) => { resolveSkills = resolve; rejectSkills = reject; });
  const timer = setTimeout(() => rejectSkills(new Error('skills snapshot missing')), 5000);
  const acceptRows = (rows: AppSkill[]) => { if (rows.some(row => row.id === wrapper.id && row.enabled && row.validationStatus === 'valid')) resolveSkills(rows); };
  const stopSkills = hub.onEvent<{ subscriptionId: string; rows: AppSkill[] }>('liveQuery.snapshot', event => { if (event.subscriptionId === 'skill-default-proof') acceptRows(event.rows); });
  const stopDelta = hub.onEvent<{ subscriptionId: string; added?: AppSkill[]; updated?: AppSkill[] }>('liveQuery.delta', event => { if (event.subscriptionId === 'skill-default-proof') acceptRows([...(event.added ?? []), ...(event.updated ?? [])]); });
  try {
    await hub.request('liveQuery.subscribe', { queryName: 'skills.list', params: [], subscriptionId: 'skill-default-proof' });
    assert.equal((await snapshot).find(row => row.id === wrapper.id)!.enabled, true);
  } finally { clearTimeout(timer); stopSkills(); stopDelta(); await hub.request('liveQuery.unsubscribe', { subscriptionId: 'skill-default-proof' }); }
  evidence.skillLiveQueryReadback = true; evidence.validationThroughLiveQuery = true;
  let notices = 0; stopEvents = app.internalEventBus.subscribe('skills.changed', () => { notices++; }, { subscriberName: 'skill-default-proof' });
  const before = readDefault();
  const jobsBefore = raw.prepare("SELECT count(*) AS n FROM job_queue WHERE queue='skill.validate'").get()!.n;
  raw.exec("CREATE TRIGGER reject_skill_defaults BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'synthetic skill default failure'); END");
  await assert.rejects(hub.request('skill.create', { params: { ...params, name: 'rejected-fixture' } }), /synthetic skill default failure/);
  assert.equal(app.db.skills.getByName('rejected-fixture'), null); assert.deepEqual(readDefault(), before); assert.equal(notices, 0);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM job_queue WHERE queue='skill.validate'").get()!.n, jobsBefore);
  await assert.rejects(hub.request('skill.installFromGit', { repoUrl: installUrl, commandName: 'rejected-install' }), /synthetic skill default failure/);
  assert.equal(app.db.skills.getByName('rejected-install'), null);
  assert.equal(existsSync(join(run, 'data/skill-plugins/rejected-install')), false);
  assert.deepEqual(readDefault(), before); assert.equal(notices, 0);
  evidence.rejectedInstallNotPublished = true;
  raw.exec('DROP TRIGGER reject_skill_defaults'); evidence.rollbackBeforeEnqueueOrNotice = true;
  const { skill: installed } = await hub.request<{ skill: AppSkill }>('skill.installFromGit', { repoUrl: installUrl, commandName: 'installed-fixture' });
  assert.equal(readChoice(installed.id), true); assert.match(readFileSync(join(run, 'data/skills/installed-fixture/SKILL.md'), 'utf8'), /Synthetic skill/);
  const repeated = await hub.request<{ skill: AppSkill }>('skill.installFromGit', { repoUrl: installUrl, commandName: 'installed-fixture' });
  assert.equal(repeated.skill.id, installed.id); assert.equal(fetches, 2); evidence.syntheticInstallAndIdempotence = true;
  await assert.rejects(hub.request('skill.create', { params: { ...params, name: 'invalid-fixture', config: { type: 'builtin', commandName: '' } } }), /commandName/);
  await hub.request('skill.delete', { id: skill.id }); assert.equal(readChoice(skill.id), false); assert.equal(app.db.skills.get(skill.id), null);
  await app.sessionManager.interruptInMemorySession(sessionId);
  const session = (await hub.request<{ session: Session }>('session.get', { sessionId })).session;
  assert.deepEqual(session.config.toolSelection, frozen); assert.deepEqual(session.config.sdkToolsPreset, ['Read']);
  assert.equal((await hub.request<{ state: string }>('session.getToolInventory', { sessionId })).state, 'not_running');
  evidence.frozenSessionPreserved = true; evidence.defaults = readDefault(); evidence.sessionId = sessionId; evidence.frozen = frozen;
} finally {
  stopEvents(); globalThis.fetch = originalFetch; await transport?.close(); await app?.cleanup();
  writeFileSync(join(run, 'evidence/skill-default-writes.json'), JSON.stringify(evidence, null, 2));
}
const restarted = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
const hub2 = new MessageHub({ defaultSessionId: 'global' });
const connection = new WebSocketClientTransport({ url: `ws://127.0.0.1:${restarted.server.port}/ws`, autoReconnect: false }); hub2.registerTransport(connection);
try {
  assert.notEqual(restarted.server.port, 8399); await connection.initialize();
  assert.deepEqual((await hub2.request<{ session: Session }>('session.get', { sessionId: evidence.sessionId })).session.config.toolSelection, evidence.frozen);
  assert.deepEqual(JSON.parse(String(restarted.db.getDatabase().prepare('SELECT settings FROM global_settings WHERE id=1').get()!.settings)).toolSelectionDefaults, evidence.defaults);
  evidence.restartRetainedDefaults = true; evidence.pass = true;
  console.log('PASS skill default RPC wiring: catalog/default CRUD, rollback before enqueue/notice, synthetic install, frozen session and restart; no SDK/UI flip');
} finally { await connection.close(); await restarted.cleanup(); writeFileSync(join(run, 'evidence/skill-default-writes.json'), JSON.stringify(evidence, null, 2)); }
