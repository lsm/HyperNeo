import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, lstatSync, symlinkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
git(source, 'tag', 'source-only', before);
git(source, 'pack-refs', '--all');
writeFileSync(join(remote, 'code.txt'), 'remote update');
git(remote, 'commit', '-am', 'new base');
const latest = git(remote, 'rev-parse', 'HEAD');
writeFileSync(join(source, 'code.txt'), 'human dirty bytes');
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-b1-cli.ts', import.meta.url));
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--session-id') && process.argv[process.argv.indexOf('-n') + 1] !== 'desktop-wake') { writeFileSync(${JSON.stringify(join(run, 'evidence/worker-cwd'))}, process.cwd()); writeFileSync(${JSON.stringify(join(run, 'evidence/worker-launch.json'))}, JSON.stringify({ settings: process.argv[process.argv.indexOf('--settings') + 1], brief: process.argv[process.argv.indexOf('--append-system-prompt') + 1] })); }\nif (process.argv.includes('--resume') && process.argv[process.argv.indexOf('--resume') + 1] === '0aa00000-0000-4000-8000-000000009105') writeFileSync(${JSON.stringify(join(run, 'evidence/user-resume-args.json'))}, JSON.stringify(process.argv.slice(2)));\nif (existsSync(${JSON.stringify(join(run, 'fail-cli'))})) process.exit(1);\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/script'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (existsSync(${JSON.stringify(join(run, 'fail-import'))})) { writeFileSync(join(process.cwd(), 'retained-human-note.txt'), 'Synthetic human bytes during handoff'); process.exit(1); }\nprocess.argv.push('--synthetic-desktop-import');\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
for (const name of ['open', 'gh']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
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
  const launch = JSON.parse(readFileSync(join(run, 'evidence/worker-launch.json'), 'utf8'));
  const workerEnv = JSON.parse(launch.settings).env;
  assert.equal(workerEnv.HYPERNEO_WORKTREES, join(run, 'data/worktrees'));
  assert(launch.brief.includes(workerEnv.HYPERNEO_WORKTREES));
  assert(!existsSync(join(worker, '.git/hyperneo-worker-sandbox')));
  const legacy = join(run, 'home/focus/worktrees/legacy');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'retained'), 'legacy worktree bytes');
  if (process.env.VERIFY_CLAUDE) {
    const command = 'test -n "$HYPERNEO_WORKTREES" && mkdir -p "$HYPERNEO_WORKTREES" && git worktree add --detach "$HYPERNEO_WORKTREES/worker-probe" HEAD && printf WORKTREE_HINT_CREATED';
    const native = spawnSync('python3', [fileURLToPath(new URL('./worker-cli-probe.py', import.meta.url)), process.env.VERIFY_CLAUDE, launch.settings, worker, command], { encoding: 'utf8', timeout: 180000 });
    writeFileSync(join(run, 'evidence/work-locations-native.log'), native.stdout + native.stderr);
    assert.equal(native.status, 0, native.stdout + native.stderr);
    assert(native.stdout.includes('WORKTREE_HINT_CREATED'), native.stdout);
    assert(existsSync(join(workerEnv.HYPERNEO_WORKTREES, 'worker-probe/.git')));
    const adopted = spawnSync('python3', [fileURLToPath(new URL('./worker-adopted-cli.py', import.meta.url)), process.env.VERIFY_CLAUDE, worker, launch.brief, join(run, 'evidence')], { encoding: 'utf8', timeout: 260000 });
    writeFileSync(join(run, 'evidence/adopted-resume.log'), adopted.stdout + adopted.stderr);
    assert.equal(adopted.status, 0, adopted.stdout + adopted.stderr);
    assert(existsSync(join(workerEnv.HYPERNEO_WORKTREES, 'adopted-probe/.git')));
  }
  assert.equal(readFileSync(join(legacy, 'retained'), 'utf8'), 'legacy worktree bytes');
  evidence.push({ workLocations: workerEnv, brief: launch.brief, noSandbox: true, legacyUnchanged: true, nativeVerified: !!process.env.VERIFY_CLAUDE });

  assert.notEqual(worker, source);
  assert(statSync(join(worker, '.git')).isDirectory());
  assert.equal(git(worker, 'rev-parse', '--git-common-dir'), '.git');
  assert.equal(git(worker, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(worker, 'rev-parse', 'refs/remotes/origin/dev'), latest);
  assert.equal(git(worker, 'for-each-ref', '--format=%(refname)'), 'refs/remotes/origin/dev');
  git(worker, 'switch', 'dev');
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
  writeFileSync(join(run, 'fail-import'), 'synthetic failed native handoff');
  const failedImport = await rpc('work.start', request) as { ok: boolean; detail?: string };
  assert.equal(failedImport.ok, false);
  const retainedDirectory = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
  assert.equal(readFileSync(join(retainedDirectory, 'retained-human-note.txt'), 'utf8'), 'Synthetic human bytes during handoff');
  assert.equal(git(retainedDirectory, 'rev-parse', 'HEAD'), latest);
  evidence.push({ failedImport, retainedDirectory, humanBytesRetained: true });
  assert(failedImport.detail?.includes(retainedDirectory));
  assert.match(failedImport.detail!, /local_[\da-f-]+/);
  rmSync(join(run, 'fail-import'));
  writeFileSync(join(run, 'fail-cli'), 'synthetic failed CLI start');
  const failedStart = await rpc('work.start', request) as { ok: boolean; detail?: string };
  assert.equal(failedStart.ok, false);
  const failedDirectory = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
  assert.notEqual(failedDirectory, worker);
  assert.equal(existsSync(failedDirectory), false, 'unconfirmed start releases its private clone');
  assert.equal(existsSync(worker), true, 'confirmed worker clone is retained');
  const inPlaceDirectory = join(run, 'in-place-workspace');
  mkdirSync(inPlaceDirectory);
  for (const existing of [false, true]) {
    const settings = join(inPlaceDirectory, '.claude/settings.local.json');
    const original = '{ "env": { "CUSTOM": "retained" } }\n';
    if (existing) {
      mkdirSync(join(inPlaceDirectory, '.claude'));
      writeFileSync(settings, original);
    }
    const inPlaceFailed = await rpc('work.start', { adapter: 'claude-desktop', place: { machine: hostname(), folder: inPlaceDirectory, name: 'Synthetic in-place folder' }, title: 'Synthetic failed in-place worker', message: 'Never dispatched', inPlace: true }) as { ok: boolean; reason?: string };
    assert.equal(inPlaceFailed.ok, false);
    assert.equal(inPlaceFailed.reason, 'not_delivered');
    assert.equal(readFileSync(join(run, 'evidence/worker-cwd'), 'utf8'), inPlaceDirectory);
    if (existing) assert.equal(readFileSync(settings, 'utf8'), original);
    else assert.equal(existsSync(join(inPlaceDirectory, '.claude')), false);
    evidence.push({ inPlaceFailed, existingSettings: existing, projectSettingsUnchanged: true });
  }
  rmSync(join(run, 'fail-cli'));
  const linkedDirectory = join(run, 'linked-workspace');
  const dotfiles = join(run, 'dotfile-settings');
  mkdirSync(linkedDirectory);
  mkdirSync(dotfiles);
  writeFileSync(join(dotfiles, 'settings.local.json'), JSON.stringify({ env: { DOTFILE_OWNER: 'retained' } }));
  symlinkSync(dotfiles, join(linkedDirectory, '.claude'));
  const linkedStart = await rpc('work.start', { adapter: 'claude-desktop', place: { machine: hostname(), folder: linkedDirectory, name: 'Synthetic linked folder' }, title: 'Synthetic linked worker', message: 'Never dispatched' }) as { ok: boolean };
  assert.equal(linkedStart.ok, true);
  assert(lstatSync(join(linkedDirectory, '.claude')).isSymbolicLink());
  const linkedSettings = JSON.parse(readFileSync(join(dotfiles, 'settings.local.json'), 'utf8'));
  assert.equal(linkedSettings.env.DOTFILE_OWNER, 'retained');
  assert.equal(linkedSettings.env.HYPERNEO_WORKTREES, workerEnv.HYPERNEO_WORKTREES);
  evidence.push({ linkedStart, symlinkPreserved: true, customSettingPreserved: true, locationsPersisted: true });
  for (const original of ['[]', '"text"', '42', 'null', '{"env":[]}', '{"env":"text"}', '{"env":42}', '{"env":null}']) {
    const invalidDirectory = join(run, `invalid-settings-${evidence.length}`);
    mkdirSync(join(invalidDirectory, '.claude'), { recursive: true });
    const invalidPath = join(invalidDirectory, '.claude/settings.local.json');
    writeFileSync(invalidPath, original);
    const before = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
    const rejected = await rpc('work.start', { adapter: 'claude-desktop', place: { machine: hostname(), folder: invalidDirectory, name: 'Synthetic invalid settings' }, title: 'Synthetic invalid worker', message: 'Never dispatched' }) as { ok: boolean; reason?: string };
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'preparation_failed');
    assert.equal(readFileSync(invalidPath, 'utf8'), original);
    assert.equal(readFileSync(join(run, 'evidence/worker-cwd'), 'utf8'), before);
    evidence.push({ settingsShape: original, rejected, noChildLaunched: true, sourceUnchanged: true });
  }
  const launchBeforeSettingsRefusal = readFileSync(join(run, 'evidence/worker-cwd'), 'utf8');
  const clonesBefore = readdirSync(dirname(worker)).sort();
  mkdirSync(join(remote, '.claude'));
  writeFileSync(join(remote, '.claude/settings.local.json'), 'synthetic invalid JSON');
  git(remote, 'add', '-f', '.claude/settings.local.json');
  git(remote, 'commit', '-m', 'synthetic unsupported worker settings');
  const settingsRefused = await rpc('work.start', request) as { ok: boolean; reason?: string; detail?: string };
  assert.equal(settingsRefused.ok, false);
  assert.equal(settingsRefused.reason, 'preparation_failed');
  assert.equal(readFileSync(join(run, 'evidence/worker-cwd'), 'utf8'), launchBeforeSettingsRefusal, 'no child was launched');
  assert.deepEqual(readdirSync(dirname(worker)).sort(), clonesBefore, 'unlaunched prepared clone was released');
  assert.equal(readFileSync(join(remote, '.claude/settings.local.json'), 'utf8'), 'synthetic invalid JSON');
  evidence.push({ settingsRefused, noChildLaunched: true, preparedCloneReleased: true, sourceUnchanged: true });
  writeFileSync(join(remote, '.gitattributes'), 'asset.bin filter=lfs\n');
  writeFileSync(join(remote, 'asset.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 19\n`);
  git(remote, 'add', '.');
  git(remote, 'commit', '-m', 'synthetic LFS pointer');
  const lfsRefused = await rpc('work.start', request) as { ok: boolean; detail?: string };
  assert.equal(lfsRefused.ok, false);
  assert.match(lfsRefused.detail ?? '', /LFS.*smudge filter lfs failed/s);
  assert.equal(readFileSync(join(run, 'evidence/worker-cwd'), 'utf8'), launchBeforeSettingsRefusal);
  git(source, 'remote', 'set-url', 'origin', join(run, 'absent-remote'));
  const refused = await rpc('work.start', request) as { ok: boolean; detail?: string };
  assert.equal(refused.ok, false);
  assert.match(refused.detail ?? '', /fetch_failed/);
  const userId = '0aa00000-0000-4000-8000-000000009105';
  const userDirectory = join(run, 'user-workspace');
  mkdirSync(userDirectory);
  const userSession = { id: userId, title: 'Synthetic user session', cwd: userDirectory, permissionMode: 'auto', pid: 0, status: 'idle' };
  const nativeState = join(run, 'evidence/native-sessions.json');
  writeFileSync(nativeState, JSON.stringify([...JSON.parse(readFileSync(nativeState, 'utf8')), userSession]));
  writeFileSync(join(run, 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account', `local_${userId}.json`), JSON.stringify({ sessionId: `local_${userId}`, cliSessionId: userId, cwd: userDirectory, title: userSession.title, permissionMode: 'auto', lastActivityAt: Date.now() }));
  const sender = '0bb00000-0000-4000-8000-000000009105';
  await app.db.createSession({ id: sender, title: 'Synthetic sender', workspacePath: userDirectory, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, totalCost: 0 } });
  const userSend = await rpc('work.send', { ref: { adapter: 'claude-desktop', id: `local_${userId}` }, from: `session:${sender}`, message: 'Synthetic user-created idle resume' }) as { ok: boolean };
  assert.equal(userSend.ok, true, JSON.stringify(userSend));
  const userArgs = JSON.parse(readFileSync(join(run, 'evidence/user-resume-args.json'), 'utf8')) as string[];
  assert(!userArgs.includes('--settings'));
  assert(!userArgs.includes('--append-system-prompt'));
  assert(!userArgs.join(' ').includes('HYPERNEO_'));
  assert.equal(existsSync(join(userDirectory, '.claude')), false);
  evidence.push({ userCreatedIdleResume: userSend, workerFlagsAbsent: true, userProjectSettingsAbsent: true });
  evidence.push({ port: app.server.port, worker, ownGit: true, independentObjectInodes: true, workerCommitAbsentInSource: true, dirtySourcePreserved: true, localIdentityPreserved: true, targetBranchVerified: true, onlyVerifiedRefRetained: true, lfsExplicitlyRefusedBeforeLaunch: true, failedStartCloneReleased: true, confirmedCloneRetained: true, status, scope: 'actual daemon/RPC/Git; synthetic Claude CLI; no OS sandbox claim in slice 1' });
  console.log(`PASS prepared standalone clone, independent commit, dirty source preservation and explicit refusal: ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}

process.exit(0);
