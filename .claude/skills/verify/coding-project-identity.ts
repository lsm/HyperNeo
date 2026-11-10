process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createFindWorkOperation } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { PlaceGroup } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { mirrorNeoWorkspaceProjects } from '../../../packages/daemon/src/lib/neo/packs/coding/project-mirror.ts';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../packages/daemon/src/lib/neo/packs/coding/project-mirror-async.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { recordStartedWork } from '../../../packages/daemon/src/storage/work-started-sessions.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(process.env[key], undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP refused'); }) as typeof fetch;
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
let socket: WebSocket | undefined;
const report = { verified: false, port: app.server.port, inlineProjects: 0, workerProjects: 0, stableAliases: false, protectedProjects: 0, deletedProjects: 0, resourcesClosed: false };
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  const db = app.db.getDatabase();
  const repo = new NeoRepository(db);
  for (const [id, title] of [['standalone', 'Synthetic repository'], ['tool', 'Synthetic tool']])
    repo.saveProject({ id, title, summary: '', context: '' }, 0);
  const alias = db.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)');
  alias.run(`tool:${hostname()}:synthetic`, 'tool');
  alias.run('repo:synthetic/project\u0000old', 'standalone');
  alias.run('repo:synthetic/project\u0000tool', 'tool');
  const groups: PlaceGroup[] = ['first', 'second'].map((id) => {
    const folder = join(run, 'home', id);
    mkdirSync(folder);
    recordStartedWork(db, { adapter: 'fixture', id });
    const place = { machine: hostname(), folder, name: 'Synthetic', remotes: ['git@github.com:synthetic/project.git'], toolProject: { id: 'synthetic', name: 'Synthetic tool' } };
    return { place, workspaces: [place], work: [{ ref: { adapter: 'fixture', id }, place, title: id, status: 'done', lastActivityAt: 1 }], adapters: ['fixture'], lastActivityAt: 1, openCount: 0, archivedCount: 0 };
  });
  const snapshot = () => ({
    projects: db.prepare("SELECT id, title FROM neo_concerns WHERE id IN ('standalone', 'tool') ORDER BY id").all(),
    aliases: db.prepare('SELECT alias, project_id FROM neo_project_workspaces ORDER BY alias').all(),
  });
  const registry = app.sessionManager.getOperationRegistry();
  let inline = true;
  const find = createFindWorkOperation({
    adapters: () => [{ id: 'fixture', capabilities: ['find'], find: () => groups }],
    remote: { list: () => [], invoke: async () => null },
    mirrorProjects: async (found) => {
      if (inline) mirrorNeoWorkspaceProjects(db, found);
      else await mirrorNeoWorkspaceProjectsAsync(app.db, found);
    },
  });
  app.sessionManager.setOperationRegistryProvider(() => createOperationRegistry([
    ...registry.entries.filter((entry) => entry.name !== 'work.find'), find,
  ]));
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('RPC unavailable')); });
  const rpc = <T>(name: string, input: unknown): Promise<T> => new Promise((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { socket!.removeEventListener('message', receive); fail(new Error(`${name} timed out`)); }, 15_000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id && reply.id !== id) return;
      clearTimeout(timer);
      socket!.removeEventListener('message', receive);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data);
    };
    socket!.addEventListener('message', receive);
    socket!.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name, input }, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  await rpc('work.find', { localOnly: true, limit: 50 });
  const before = snapshot();
  report.inlineProjects = before.projects.length;
  assert.equal(report.inlineProjects, 2);
  assert.equal((db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get('repository:github.com/synthetic/project') as { project_id: string }).project_id, 'standalone');
  for (const group of groups)
    assert.equal((db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get(`folder:${hostname()}\u0000${group.place.folder}`) as { project_id: string }).project_id, 'tool');
  inline = false;
  await rpc('work.find', { localOnly: true, limit: 50 });
  const after = snapshot();
  assert.deepEqual(after, before);
  report.workerProjects = after.projects.length;
  report.stableAliases = true;
  repo.saveProject({ id: 'empty', title: 'Synthetic empty', summary: '', context: '' }, 0);
  const cleanup = await rpc<{ ok: boolean; cleanupPlanned: { projectId: string }[]; cleanupFailed: unknown[] }>('neo.projects.reorganize', { apply: true });
  assert.equal(cleanup.ok, true);
  assert.deepEqual(cleanup.cleanupFailed, []);
  assert.deepEqual(cleanup.cleanupPlanned.map((item) => item.projectId), ['empty']);
  assert.equal(repo.getProject('empty'), null);
  assert(repo.getProject('standalone'));
  assert(repo.getProject('tool'));
  report.deletedProjects = 1;
  report.protectedProjects = 2;
  report.verified = true;
} finally {
  socket?.close();
  await app.cleanup();
  globalThis.fetch = originalFetch;
  report.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/project-identity.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
