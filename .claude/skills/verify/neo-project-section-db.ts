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
const issue = JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev' }, issueOrPullRequest: { __typename: 'Issue', url: 'https://github.com/synthetic/project/issues/7', title: 'Synthetic epic', state: 'OPEN' } } } });
writeFileSync(join(run, 'bin/gh'), `#!/bin/sh\ncase "$*" in *graphql*synthetic*project*) printf '%s\\n' '${issue}';; *) exit 1;; esac\n`, { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('Real HTTP refused'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, measuring = 0;
const mainSql: string[] = [], commands: unknown[] = [];
const evidence: Record<string, any> = { mode, verified: false, consumer: 'Real daemon public WebSocket neo.project.section and neo.snapshot', limitation: 'Synthetic fixtures; no GUI, model, live daemon or GitHub. No held-writer latency claim.' };
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
async function section(parentId: string, epicUrl = 'https://github.com/synthetic/project/issues/7') {
  measuring++;
  try { return await rpc('neo.project.section', { parentId, epicUrl }); }
  finally { measuring--; }
}
async function snapshot() {
  const reply = await rpc('neo.snapshot', {});
  assert(reply.ok);
  return reply.projects;
}
try {
  await open();
  const db = app!.db.getDatabase(), repo = new NeoRepository(db);
  for (const id of ['a', 'b', 'other']) repo.saveProject({ id, title: id, summary: 'Retained summary.', context: 'Retained context.' }, 0);
  for (const id of ['a', 'b']) db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(`repo:synthetic/project\u0000${id}`, id);
  evidence.missing = await section('missing', 'https://example.com/invalid');
  assert.equal((evidence.missing as any).reason, 'unknown_parent');
  evidence.invalid = await section('a', 'https://example.com/invalid');
  assert.equal((evidence.invalid as any).reason, 'invalid_epic_url');
  evidence.mismatch = await section('other');
  assert.equal((evidence.mismatch as any).reason, 'section_workspace_mismatch');
  const race = await Promise.all([section('a'), section('b')]);
  evidence.race = race;
  assert.equal(race.filter(value => value.ok).length, 1);
  assert(race.some(value => value.reason === 'epic_already_has_section'));
  const winner = race.find(value => value.ok)!;
  const projects = await snapshot(), created = projects.find((value: any) => value.id === winner.projectId);
  assert(created);
  assert.equal(created.title, 'Synthetic epic');
  assert.equal(created.epicUrl, 'https://github.com/synthetic/project/issues/7');
  assert.equal(created.revision, 1);
  assert.equal(projects.filter((value: any) => value.epicUrl === created.epicUrl).length, 1);
  evidence.retry = await section(created.parentId);
  assert.deepEqual(evidence.retry, winner);
  evidence.snapshot = await snapshot();
  await app!.cleanup(); app = undefined;
  await open();
  evidence.reopened = await snapshot();
  assert.deepEqual(evidence.reopened, evidence.snapshot);
  if (mode === 'before') assert(mainSql.length > 0, 'Baseline must reproduce section SQL on main');
  else {
    assert.deepEqual(mainSql, [], 'Section authoritative reads and writes must leave main');
    assert(commands.length >= 4);
  }
  evidence.verified = true;
} finally {
  evidence.mainSql = mainSql; evidence.commands = commands;
  await app?.cleanup(); globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/neo-project-section-db.json'), JSON.stringify(evidence, null, 2));
}
