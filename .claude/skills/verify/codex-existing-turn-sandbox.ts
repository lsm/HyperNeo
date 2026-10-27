import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSigningAgent } from './signing-agent.ts';
import { startCodexBootstrapServer } from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { steerCodexDesktopTurn } from '../../../packages/daemon/src/lib/drivers/codex-desktop-handoff.ts';
import { queueCodexMessage, type CodexDesktopAdapterDeps } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { codexWorkerSandbox, configureWorkerSandbox, prepareWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const [codex, route, runArg] = process.argv.slice(2);
const run = resolve(runArg);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert(codex.startsWith('/')); assert(['desktop', 'queue'].includes(route));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
process.env.CODEX_HOME = join(run, 'home/.codex'); mkdirSync(process.env.CODEX_HOME, { recursive: true });
const worker = join(run, 'worker'); mkdirSync(worker, { recursive: true }); mkdirSync(join(run, 'evidence'), { recursive: true });
assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=dev'], { cwd: worker }).status, 0);
await prepareWorkerSandbox(worker);
const signing = startSigningAgent(run);
const model = spawn('python3', [fileURLToPath(new URL('./worker-sandbox-model.py', import.meta.url)), run, worker, 'codex-app-server'], {
  env: { ...process.env, VERIFY_LOOPBACK: '1', ...signing.env }, stdio: ['ignore', 'pipe', 'pipe'],
});
let modelLog = '';
model.stdout.on('data', (chunk) => { modelLog += chunk; }); model.stderr.on('data', (chunk) => { modelLog += chunk; });
const modelDone = new Promise((done) => model.once('exit', done));
const wait = async (condition: () => boolean) => {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    assert(model.exitCode === null && Date.now() < deadline, modelLog || 'existing-turn native proof timed out');
    await new Promise((done) => setTimeout(done, 100));
  }
};
const sockets = new Set<Socket>();
let peer: ReturnType<typeof createServer> | undefined;
let server: Awaited<ReturnType<typeof startCodexBootstrapServer>> | undefined;
const calls: { method: string; params: unknown }[] = [];
const observed: Record<string, unknown> = { route, preference: 'off' };
try {
  await wait(() => existsSync(join(run, 'evidence/codex-app-server-port')));
  const port = Number(readFileSync(join(run, 'evidence/codex-app-server-port'), 'utf8')); assert(port > 0 && port !== 8399);
  server = await startCodexBootstrapServer(codex);
  const normal = codexWorkerSandbox(worker);
  const started = await server.call('thread/start', {
    cwd: worker, permissions: 'old-restricted', approvalPolicy: 'never', model: 'synthetic',
    config: { ...normal.config,
      permissions: { ...normal.config.permissions, 'old-restricted': { ...normal.config.permissions['hyperneo-worker'], network: { enabled: false } } },
      model_provider: 'synthetic', model_providers: { synthetic: { name: 'Synthetic', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false } },
      features: { ...normal.config.features, shell_snapshot: false },
    },
  }) as { thread: { id: string; path: string }; activePermissionProfile: { id: string } };
  assert.equal(started.activePermissionProfile?.id, 'old-restricted'); observed.initialProfile = started.activePermissionProfile.id;
  const id = started.thread.id;
  configureWorkerSandbox(() => 'off');
  if (route === 'desktop') {
    peer = createServer((socket) => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
      const reply = (requestId: string, result: object) => {
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId, ...result })); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
      };
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
          const size = buffer.readUInt32LE(0); const request = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
          calls.push({ method: request.method, params: request.params });
          if (request.method === 'initialize') reply(request.requestId, { resultType: 'success', result: { clientId: 'synthetic-client' } });
          else if (request.method === 'thread-owner-discovery') reply(request.requestId, { resultType: 'success', handledByClientId: 'synthetic-owner' });
          else if (request.method === 'thread-follower-start-turn') {
            void server!.call('turn/start', request.params.turnStart.request).then(
              (result) => reply(request.requestId, { resultType: 'success', result: { result } }),
              (error) => reply(request.requestId, { resultType: 'error', error: String(error) })
            );
          } else reply(request.requestId, { resultType: 'error', error: 'NoActiveTurn' });
        }
      });
    });
    const path = join(run, 'ipc.sock'); await new Promise<void>((done) => peer!.listen(path, done));
    observed.delivery = await steerCodexDesktopTurn(path, () => { throw new Error('Real Desktop launch refused'); }, id, 'Run the synthetic probe.', 'synthetic-input', 'auto', async () => true);
    assert.equal((observed.delivery as { reason: { ok: boolean } }).reason.ok, true);
  } else {
    const deps = {
      appServer: async () => ({ call: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return server!.call(method, params); }, close: () => {} }),
      newId: () => crypto.randomUUID(), desktopRunning: async () => false,
      spawn: () => { throw new Error('Unexpected offline CLI fallback'); },
    } as unknown as CodexDesktopAdapterDeps;
    observed.delivery = await queueCodexMessage({ thread: { id, folder: worker, title: 'Synthetic old worker', archived: 0, updatedAt: 1, rolloutPath: started.thread.path }, roots: [] }, 'Run the synthetic probe.', deps, 'queue');
    assert.equal((observed.delivery as { ok: boolean }).ok, true, JSON.stringify(observed.delivery));
  }
  await wait(() => existsSync(started.thread.path) && readFileSync(started.thread.path, 'utf8').includes('task_complete'));
  const records = readFileSync(started.thread.path, 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const context = records.filter((record) => record.type === 'turn_context').at(-1)?.payload;
  const local = join(worker, 'loopback-observed.json');
  observed.sandboxPolicy = context?.sandbox_policy;
  observed.activeProfile = context?.active_permission_profile?.id ?? null;
  observed.loopbackConnected = existsSync(local) && JSON.parse(readFileSync(local, 'utf8')).connected === true;
  observed.outsideWritePermitted = existsSync(join(run, 'codex-app-server-outside/escaped.txt'));
  observed.signedCommit = existsSync(join(worker, 'signed-codex-app-server.txt')) && readFileSync(join(worker, 'signed-codex-app-server.txt'), 'utf8').trim() === '1';
  observed.networkFetch = existsSync(join(worker, 'network-codex-app-server.txt')) && readFileSync(join(worker, 'network-codex-app-server.txt'), 'utf8') === 'synthetic-network-ok';
  assert.equal(observed.loopbackConnected, true, 'Existing thread retained its restricted loopback policy');
  assert.equal(observed.networkFetch, true, 'Existing thread could not fetch the synthetic network endpoint');
  assert.equal(observed.signedCommit, true, 'Existing thread could not sign through its throwaway agent');
  assert.equal(observed.outsideWritePermitted, true, 'Off preference retained old filesystem restrictions');
  assert.equal((observed.sandboxPolicy as { type: string }).type, 'danger-full-access');
} finally {
  for (const socket of sockets) socket.destroy();
  if (peer) await new Promise<void>((done) => peer!.close(() => done()));
  await server?.close(); signing.stop();
  writeFileSync(join(run, 'codex-app-server-finish'), 'done'); model.kill(); await modelDone;
  observed.calls = JSON.parse(JSON.stringify(calls).replaceAll(run, '<run>'));
  observed.cleanup = { appServerClosed: true, modelClosed: true, signingAgentStopped: true };
  writeFileSync(join(run, 'evidence/existing-turn-sandbox.json'), JSON.stringify(observed, null, 2));
  writeFileSync(join(run, 'evidence/model.log'), modelLog);
}
console.log('ok existing Codex turn applies current off preference and performs real local network, signing and filesystem work');
