import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Session } from '@hyperneo/shared';
import { projectRootOf, projectName } from '../../../packages/web/src/lib/projects.ts';
import { getWorktreeBaseDir } from '../../../packages/daemon/src/lib/worktree-path-utils.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['bin', 'evidence', 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const remote = join(run, 'remote');
const source = join(run, 'source');
git(run, 'init', '--initial-branch=dev', remote);
git(remote, 'config', 'user.name', 'Synthetic');
git(remote, 'config', 'user.email', 'synthetic@example.invalid');
writeFileSync(join(remote, 'AGENTS.md'), '## Verify\nUse the synthetic proof.\n');
writeFileSync(join(remote, 'code.txt'), 'base');
git(remote, 'add', '.');
git(remote, 'commit', '-m', 'initial');
git(run, 'clone', remote, source);
git(source, 'config', 'user.name', 'Repo Worker');
git(source, 'config', 'user.email', 'repo-worker@example.invalid');
git(source, 'config', 'commit.gpgsign', 'false');
const before = git(source, 'rev-parse', 'HEAD');
git(source, 'tag', 'source-only', before);
git(source, 'pack-refs', '--all');
writeFileSync(join(remote, 'code.txt'), 'remote update');
git(remote, 'commit', '-am', 'new base');
const latest = git(remote, 'rev-parse', 'HEAD');
writeFileSync(join(source, 'code.txt'), 'human dirty bytes');
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (name: string, input: unknown, plain = false) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { ws!.removeEventListener('message', receive); fail(new Error(`${name} timed out`)); }, 30000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      ws!.removeEventListener('message', receive);
      clearTimeout(timer);
      evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: plain ? name : 'operation.invoke', data: plain ? input : { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  await rpc('customEndpoints.add', { endpoint: { id: 'synthetic', name: 'Synthetic', type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'synthetic', name: 'Synthetic' }] } }, true);
  const registry = await rpc('mcp.registry.list', {}, true) as { servers: { id: string }[] };
  for (const server of registry.servers) await rpc('mcp.registry.setEnabled', { id: server.id, enabled: false }, true);
  await rpc('models.list', { forceRefresh: true }, true);
  const started = await rpc('work.start', {
    adapter: 'hyperneo', place: { machine: hostname(), folder: source, name: 'Synthetic source' },
    title: 'Prepared project session', message: 'Synthetic placement only', model: 'synthetic',
    preparation: { pack: 'coding', parameters: { target: 'dev', prerequisiteCommits: [before] } },
  }) as Result<WorkStarted>;
  assert(started.ok, JSON.stringify(started));
  const unprepared = await rpc('work.start', {
    adapter: 'hyperneo', place: { machine: hostname(), folder: source, name: 'Synthetic source' },
    title: 'Ordinary project session', message: 'Synthetic placement only', model: 'synthetic',
  }) as Result<WorkStarted>;
  assert(unprepared.ok, JSON.stringify(unprepared));
  const listed = await rpc('session.list', {}, true) as { sessions: Session[] };
  const session = listed.sessions.find((s) => s.id === started.value.ref.id)!;
  assert(session);
  const worker = session.workspacePath!;
  const group = projectRootOf(session);
  const expected = join(getWorktreeBaseDir(source), session.id);
  evidence.push({ worker, expected, group, groupName: group ? projectName(group) : null, session });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  assert.equal(worker, expected, 'prepared clone belongs in its repo project and is named by session ID');
  assert.equal(group, source, 'sidebar session.list grouping uses the original project');
  assert.equal(started.value.place.folder, source, 'work discovery uses the original project');
  const ordinary = listed.sessions.find((s) => s.id === unprepared.value.ref.id)!;
  assert.equal(projectRootOf(ordinary), source);
  assert.equal(ordinary.workspacePath, join(getWorktreeBaseDir(source), ordinary.id));
  evidence.push({ ordinary, sameParent: true });
  assert(!existsSync(join(run, 'data/Neo/worktrees')));
  assert(statSync(join(worker, '.git')).isDirectory());
  assert.equal(git(worker, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(worker, 'rev-parse', 'refs/remotes/origin/dev'), latest);
  const blob = git(source, 'rev-parse', `${latest}:code.txt`);
  const object = join('.git/objects', blob.slice(0, 2), blob.slice(2));
  assert.notEqual(statSync(join(source, object)).ino, statSync(join(worker, object)).ino);
  assert.equal(git(source, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(source, 'code.txt'), 'utf8'), 'human dirty bytes');
  const snapshot = await rpc('daemon.snapshot', { limit: 50 }) as { resources: { kind: string; entries: { id: string; workspacePath: string }[] }[] };
  const inventory = snapshot.resources.find((page) => page.kind === 'session')!.entries.find((entry) => entry.id === session.id)!;
  const inspected = await rpc('daemon.session.inspect', { sessionId: session.id }) as { accepted: boolean; resource: { workspacePath: string } };
  assert(inspected.accepted, JSON.stringify(inspected));
  assert.equal(inspected.resource.workspacePath, source);
  evidence.push({ inventory, inspected });
  assert.equal(inventory.workspacePath, source);
  for (const folder of [source, source + '/']) {
    const next = await rpc('work.start', {
      adapter: 'hyperneo', place: { machine: hostname(), folder, name: 'Synthetic source' },
      title: 'Path variant', message: 'Synthetic placement only', model: 'synthetic',
      preparation: { pack: 'coding', parameters: { target: 'dev' } },
    }) as Result<WorkStarted>;
    assert(next.ok, JSON.stringify(next));
    const path = join(getWorktreeBaseDir(source), next.value.ref.id);
    assert(existsSync(path));
    await rpc('session.archive', { sessionId: next.value.ref.id, confirmed: true }, true);
    await rpc('session.delete', { sessionId: next.value.ref.id }, true);
    assert(existsSync(path), 'placement changes do not release prepared clones');
    evidence.push({ folder, path, archivedAndDeleted: true, cloneRetained: true });
  }
  assert(existsSync(source));
  console.log(`PASS prepared clone location, sidebar project group, pinned base and independent objects: ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
