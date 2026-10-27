import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const part of ['home', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('Real HTTP refused'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, measuring = 0;
const mainSql: string[] = [], commands: unknown[] = [];
const evidence: Record<string, any> = { mode, verified: false, consumer: 'Real daemon public WebSocket neo.project.move and neo.snapshot', limitation: 'Synthetic fixtures; no GUI, model, live daemon or GitHub. No held-writer latency claim.' };
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase(), prepare = db.prepare.bind(db), send = app.db.gateway.run.bind(app.db.gateway);
  db.prepare = ((sql: string) => { if (measuring && /neo_concerns|neo_project_workspaces|neo_project_merges/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof db.prepare;
  app.db.gateway.run = (async (op, args) => {
    const start = performance.now(), value = await send(op, args);
    if (op.name === 'neo.project.move') commands.push({ name: op.name, durationMs: performance.now() - start, argsBytes: Buffer.byteLength(JSON.stringify(args)), replyBytes: Buffer.byteLength(JSON.stringify(value)) });
    return value;
  }) as typeof app.db.gateway.run;
}
async function rpc(name: string, input: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${app!.server.port}/ws`);
  try {
    await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('RPC connect failed')); });
    return await new Promise<any>((done, fail) => {
      const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timed out')), 10000);
      ws.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data); };
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  } finally { ws.close(); }
}
async function move(id: string, parentId: string | null, expectedRevision: number) {
  measuring++; try { return await rpc('neo.project.move', { id, parentId, expectedRevision }); } finally { measuring--; }
}
async function snapshot() { const reply = await rpc('neo.snapshot', { projectId: 'child' }); assert(reply.ok); return reply.projects; }
try {
  await open(); const db = app!.db.getDatabase(), repo = new NeoRepository(db);
  for (const id of ['a', 'b', 'child', 'group']) repo.saveProject({ id, title: id, summary: 'Retained summary.', context: 'Retained context.' }, 0);
  db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run('repo:synthetic/project\u0000history', 'a');
  assert(repo.moveProject('group', 'a', 1).ok);
  repo.saveProject({ id: 'section', title: 'Synthetic epic', summary: 'Fixture section.', context: '' }, 0);
  db.prepare('UPDATE neo_concerns SET parent_id=?, epic_url=? WHERE id=?').run('group', 'https://github.com/synthetic/project/issues/7', 'section');
  const section = { projectId: 'section' };
  evidence.race = await Promise.all([move('child', 'a', 1), move('child', 'b', 1)]);
  assert.equal(evidence.race.filter((value: any) => value.ok).length, 1);
  assert(evidence.race.some((value: any) => value.reason === 'superseded'));
  evidence.snapshot = await snapshot();
  const current = evidence.snapshot.find((project: any) => project.id === 'child');
  assert.equal(current.revision, 2); assert.equal(current.context, 'Retained context.'); assert.equal(current.summary, 'Retained summary.');
  evidence.noop = await move('child', current.parentId, 2); assert(evidence.noop.ok);
  evidence.stale = await move('child', null, 1); assert.equal(evidence.stale.reason, 'superseded');
  evidence.cycle = await move('a', section.projectId, 999); assert.equal(evidence.cycle.reason, 'project_cycle');
  evidence.workspace = await move('group', 'b', 2); assert.equal(evidence.workspace.reason, 'section_workspace_mismatch');
  evidence.orphan = await move(section.projectId, null, 1); assert.equal(evidence.orphan.reason, 'section_needs_parent');
  evidence.missing = await move('missing', null, 999); assert.equal(evidence.missing.reason, 'unknown_project');
  assert.deepEqual(await snapshot(), evidence.snapshot);
  await app!.cleanup(); app = undefined; await open(); evidence.reopened = await snapshot(); assert.deepEqual(evidence.reopened, evidence.snapshot);
  if (mode === 'before') assert(mainSql.length > 0, 'Baseline must reproduce project SQL on main');
  else { assert.deepEqual(mainSql, [], 'Project move authoritative reads and updates must leave main'); assert(commands.length >= 8); }
  evidence.verified = true;
} finally {
  evidence.mainSql = mainSql; evidence.commands = commands;
  writeFileSync(join(run, 'evidence/neo-project-move-db.json'), JSON.stringify(evidence, null, 2));
  await app?.cleanup(); globalThis.fetch = network;
}
