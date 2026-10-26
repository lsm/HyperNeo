import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCodexBootstrapServer } from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { queueCodexMessage, type CodexDesktopAdapterDeps } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { codexWorkerSandbox, prepareWorkerSandbox, releaseWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const [codex, runArg] = process.argv.slice(2);
const run = resolve(runArg);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert(codex.startsWith('/'));
process.env.CODEX_HOME = join(run, 'home/.codex');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const worker = join(run, 'workers/codex');
mkdirSync(worker, { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const git = spawnSync('git', ['init', '--initial-branch=dev'], { cwd: worker, encoding: 'utf8' });
assert.equal(git.status, 0, git.stderr);
await prepareWorkerSandbox(worker);
const model = spawn('python3', [fileURLToPath(new URL('./worker-sandbox-model.py', import.meta.url)), run, worker, 'codex-app-server'], {
  env: { ...process.env, VERIFY_LOOPBACK: '1', VERIFY_SECRET_READ: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let modelLog = '';
model.stdout.on('data', chunk => { modelLog += chunk; });
model.stderr.on('data', chunk => { modelLog += chunk; });
const modelDone = new Promise(resolve => model.once('exit', resolve));
const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 45000;
  while (!predicate()) {
    assert(model.exitCode === null && Date.now() < deadline, modelLog || 'queued loopback proof timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
let server: Awaited<ReturnType<typeof startCodexBootstrapServer>> | undefined;
const calls: unknown[] = [];
try {
  await wait(() => existsSync(join(run, 'evidence/codex-app-server-port')));
  const port = readFileSync(join(run, 'evidence/codex-app-server-port'), 'utf8');
  assert.notEqual(port, '8399');
  server = await startCodexBootstrapServer(codex);
  const sandbox = codexWorkerSandbox(worker);
  const started = await server.call('thread/start', {
    cwd: worker, permissions: sandbox.permissions, approvalPolicy: 'never', model: 'synthetic',
    config: { ...sandbox.config,
      permissions: { ...sandbox.config.permissions, 'hyperneo-loopback-restricted': { ...sandbox.config.permissions['hyperneo-worker'], network: { enabled: false } } },
      model_provider: 'synthetic',
      model_providers: { synthetic: { name: 'Synthetic', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false } },
      features: { ...sandbox.config.features, shell_snapshot: false },
    },
  }) as { thread: { id: string; path: string }; activePermissionProfile: { id: string } };
  assert.equal(started.activePermissionProfile?.id, sandbox.permissions);
  const id = started.thread.id;
  await server.call('thread/settings/update', { threadId: id, permissions: 'hyperneo-loopback-restricted' });
  const deps = {
    appServer: async () => ({
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return server!.call(method, params);
      }, close: () => {},
    }),
    newId: () => crypto.randomUUID(),
    spawn: () => { throw new Error('Unexpected CLI fallback'); },
  } as unknown as CodexDesktopAdapterDeps;
  const queued = await queueCodexMessage({ thread: { id, folder: worker, title: 'Synthetic worker', archived: 0, updatedAt: 1, rolloutPath: started.thread.path }, roots: [] }, 'Run the synthetic probe.', deps);
  assert(queued.ok, JSON.stringify(queued));
  await wait(() => {
    const path = join(run, 'evidence/codex-app-server-requests.json');
    if (!existsSync(path)) return false;
    try { return JSON.parse(readFileSync(path, 'utf8')).length >= 2; } catch { return false; }
  });
  const path = join(worker, 'loopback-observed.json');
  const contexts = readFileSync(started.thread.path, 'utf8').split('\n').flatMap(line => {
    try { const record = JSON.parse(line); return record.type === 'turn_context' ? [record.payload] : []; } catch { return []; }
  });
  const observed = { calls, localServer: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null,
    profileId: contexts.at(-1)?.active_permission_profile?.id,
    secretRefused: readFileSync(join(worker, 'secret-read-status-codex-app-server.txt'), 'utf8') !== '0' && readFileSync(join(worker, 'secret-read-result-codex-app-server.txt'), 'utf8') === '',
    repoReadable: readFileSync(join(worker, 'repo-read-result-codex-app-server.txt'), 'utf8') === 'synthetic-repo-readable',
    outsideRefused: !existsSync(join(run, 'codex-app-server-outside/escaped.txt')),
  };
  writeFileSync(join(run, 'evidence/queued-loopback.json'), JSON.stringify(observed, null, 2));
  assert.equal(observed.profileId, sandbox.permissions, 'Queued turn lost its named worker profile');
  assert(observed.secretRefused && observed.repoReadable, 'Secret denial and ordinary repository reads must both hold');
  assert(observed.localServer?.connected, 'Queued worker could not start/connect to a loopback server');
  assert(observed.outsideRefused, 'Worker wrote outside its allowed roots');
} finally {
  await server?.close();
  writeFileSync(join(run, 'codex-app-server-finish'), 'done');
  model.kill();
  await modelDone;
  await releaseWorkerSandbox(worker);
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ appServerClosed: true, modelClosed: true, runtimeReleased: true }));
  writeFileSync(join(run, 'evidence/model.log'), modelLog);
  writeFileSync(join(run, 'evidence/queue-calls.json'), JSON.stringify(calls, null, 2));
}
