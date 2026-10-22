import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
writeFileSync(join(remote, 'code.txt'), 'remote update');
git(remote, 'commit', '-am', 'new base');
const latest = git(remote, 'rev-parse', 'HEAD');
writeFileSync(join(source, 'code.txt'), 'human dirty bytes');
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-link-cli.ts', import.meta.url));
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(run, 'evidence/worker-cwd'))}, process.cwd());\nif (existsSync(${JSON.stringify(join(run, 'fail-cli'))})) process.exit(1);\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
for (const name of ['script', 'open', 'gh']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
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
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const request = {
    adapter: 'claude-desktop',
    place: { machine: hostname(), folder: source, name: 'Synthetic source' },
    title: 'Synthetic prepared clone', message: 'Synthetic task only',
    preparation: { pack: 'coding', parameters: { target: 'dev', prerequisiteCommits: [before] } },
  };
  const started = await rpc('work.start', request) as Result<WorkStarted>;
  assert(started.ok, JSON.stringify(started));
  const worker = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
  assert.notEqual(worker, source);
  assert(statSync(join(worker, '.git')).isDirectory());
  assert.equal(git(worker, 'rev-parse', '--git-common-dir'), '.git');
  assert.equal(git(worker, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(worker, 'remote', 'get-url', 'origin'), remote);
  const blob = git(source, 'rev-parse', `${latest}:code.txt`);
  const object = join('.git/objects', blob.slice(0, 2), blob.slice(2));
  const original = statSync(join(source, object));
  const copied = statSync(join(worker, object));
  assert.notDeepEqual([original.dev, original.ino], [copied.dev, copied.ino]);
  assert.equal(git(worker, 'config', '--local', 'user.name'), 'Repo Worker');
  assert.equal(git(worker, 'config', '--local', 'user.email'), 'repo-worker@example.invalid');
  assert.equal(git(worker, 'config', '--local', 'commit.gpgsign'), 'false');
  git(worker, 'checkout', '-b', 'worker-change');
  writeFileSync(join(worker, 'worker.txt'), 'independent worker change');
  git(worker, 'add', 'worker.txt');
  git(worker, 'commit', '-m', 'worker change');
  const workerCommit = git(worker, 'rev-parse', 'HEAD');
  assert.equal(git(worker, 'log', '-1', '--format=%cn <%ce>'), 'Repo Worker <repo-worker@example.invalid>');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', workerCommit], { cwd: source }).status, 0);
  assert.equal(git(source, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(source, 'code.txt'), 'utf8'), 'human dirty bytes');
  const status = await rpc('work.status', { ref: started.value.ref });
  writeFileSync(join(run, 'fail-cli'), 'synthetic failed CLI start');
  const failedStart = await rpc('work.start', request) as { ok: boolean; detail?: string };
  assert.equal(failedStart.ok, false);
  const failedDirectory = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
  assert.notEqual(failedDirectory, worker);
  assert.equal(existsSync(failedDirectory), false, 'unconfirmed start releases its private clone');
  assert.equal(existsSync(worker), true, 'confirmed worker clone is retained');
  git(source, 'remote', 'set-url', 'origin', join(run, 'absent-remote'));
  const refused = await rpc('work.start', request) as { ok: boolean; detail?: string };
  assert.equal(refused.ok, false);
  assert.match(refused.detail ?? '', /fetch_failed/);
  evidence.push({ port: app.server.port, worker, ownGit: true, independentObjectInodes: true, workerCommitAbsentInSource: true, dirtySourcePreserved: true, localIdentityPreserved: true, failedStartCloneReleased: true, confirmedCloneRetained: true, status, scope: 'actual daemon/RPC/Git; synthetic Claude CLI; no OS sandbox claim in slice 1' });
  console.log(`PASS prepared standalone clone, independent commit, dirty source preservation and explicit refusal: ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}

process.exit(0);
