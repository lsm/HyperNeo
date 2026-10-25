import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexDesktopAdapter } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
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
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nif (process.argv.includes('--session-id') && process.argv[process.argv.indexOf('-n') + 1] !== 'desktop-wake') writeFileSync(${JSON.stringify(join(run, 'evidence/worker-cwd'))}, process.cwd());\nif (existsSync(${JSON.stringify(join(run, 'fail-cli'))})) process.exit(1);\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/script'), `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif (existsSync(${JSON.stringify(join(run, 'fail-import'))})) { writeFileSync(join(process.cwd(), 'retained-human-note.txt'), 'Synthetic human bytes during handoff'); process.exit(1); }\nprocess.argv.push('--synthetic-desktop-import');\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
for (const name of ['open', 'gh']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let sdkModel: ReturnType<typeof spawn> | undefined;
const buildOptions = QueryOptionsBuilder.prototype.build;
let sdkBaseUrl = '';
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await buildOptions.apply(this, args);
  assert(sdkBaseUrl, 'SDK model endpoint must be loopback');
  writeFileSync(join(run, 'evidence/sdk-options.json'), JSON.stringify({ cwd: options.cwd, sandbox: options.sandbox, temp: options.env?.TMPDIR }, null, 2));
  return { ...options, spawnClaudeCodeProcess: (child) => spawn(child.command, child.args, { cwd: child.cwd, env: { ...child.env, ANTHROPIC_BASE_URL: sdkBaseUrl }, stdio: ['pipe', 'pipe', 'pipe'], signal: child.signal }) };
};
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
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: name.startsWith('rpc:') ? name.slice(4) : 'operation.invoke', data: name.startsWith('rpc:') ? input : { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
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
  const proof = spawnSync('python3', [fileURLToPath(new URL('./worker-sandbox-model.py', import.meta.url)), run, worker], { encoding: 'utf8', timeout: 120000 });
  evidence.push({ stdout: proof.stdout, stderr: proof.stderr, status: proof.status });
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  const codexWorker = join(run, 'codex-worker');
  git(run, 'clone', '--no-hardlinks', remote, codexWorker);
  const codex = createCodexDesktopAdapter({
    statePath: join(run, 'codex-state.sqlite'), worktreesDir: join(run, 'codex-worktrees'),
    machine: hostname(), now: Date.now, homeDir: join(run, 'home'), newId: () => 'synthetic-codex',
    folderExists: existsSync, makeFolder: (folder) => { mkdirSync(folder, { recursive: true }); },
    gitCheckout: async () => ({ repo: source, linked: false }),
    prepareExecution: async () => ({ ok: true, value: { directory: codexWorker, release: async () => {} } }),
    spawn: () => { throw new Error('Unexpected process'); },
    appServer: async () => { throw new Error('Unexpected shared server'); },
    prepareDesktopProject: async () => 'synthetic-project',
    bootstrapServer: async () => ({
      call: async (method, params) => {
        if (method === 'thread/start') {
          writeFileSync(join(run, 'evidence/codex-launch.json'), JSON.stringify(params, null, 2));
          return { thread: { id: 'synthetic-codex' } };
        }
        return {};
      }, close: () => {},
    }),
    startDesktopTurn: async (_id, params) => {
      writeFileSync(join(run, 'evidence/codex-turn.json'), JSON.stringify(params, null, 2));
      const result = spawnSync('python3', [fileURLToPath(new URL('./worker-sandbox-model.py', import.meta.url)), run, codexWorker, 'codex'], { encoding: 'utf8', timeout: 120000 });
      evidence.push({ engine: 'codex', stdout: result.stdout, stderr: result.stderr, status: result.status });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  });
  const codexResult = await codex.start!(request, { from: 'synthetic', caller: { source: 'rpc' } });
  assert(codexResult.ok, JSON.stringify(codexResult));
  await app.jobProcessor.stop();
  const registry = await rpc('rpc:mcp.registry.list', {}) as { servers: { id: string }[] };
  for (const server of registry.servers) await rpc('rpc:mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-synthetic-loopback-only' } });
  const sdk = await rpc('work.start', { ...request, adapter: 'hyperneo', title: 'SDK sandbox' }) as Result<WorkStarted>;
  assert(sdk.ok, JSON.stringify(sdk));
  const sdkWorker = app.db.getSession(sdk.value.ref.id)!.workspacePath!;
  assert(sdkWorker !== source);
  sdkModel = spawn('python3', [fileURLToPath(new URL('./worker-sandbox-model.py', import.meta.url)), run, sdkWorker, 'sdk'], { stdio: 'ignore' });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 60000;
    while (!predicate()) {
      assert(Date.now() < deadline, 'SDK probe timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await wait(() => existsSync(join(run, 'evidence/sdk-port')));
  sdkBaseUrl = `http://127.0.0.1:${readFileSync(join(run, 'evidence/sdk-port'), 'utf8')}`;
  app.jobProcessor.start();
  await wait(() => existsSync(join(sdkWorker, 'network-sdk.txt')) && readFileSync(join(sdkWorker, 'network-sdk.txt'), 'utf8') === 'synthetic-network-ok');
  const sdkSettings = JSON.parse(readFileSync(join(sdkWorker, '.claude/settings.local.json'), 'utf8'));
  const sdkTemp = readFileSync(join(sdkWorker, 'observed-temp-sdk.txt'), 'utf8');
  const observed = {
    insideAllowed: readFileSync(join(sdkWorker, 'inside-sdk.txt'), 'utf8') === 'inside',
    outsideRefused: !existsSync(join(run, 'sdk-outside/escaped.txt')),
    gitAllowed: existsSync(join(sdkWorker, '.git/hyperneo-probe-sdk')),
    tempAllowed: sdkTemp.startsWith(sdkSettings.env.TMPDIR + '/') && existsSync(join(sdkTemp, 'probe-sdk')),
    cacheAllowed: existsSync(join(sdkSettings.env.XDG_CACHE_HOME, 'probe-sdk')),
    networkAllowed: true,
  };
  writeFileSync(join(run, 'evidence/sdk-observed.json'), JSON.stringify(observed, null, 2));
  assert(Object.values(observed).every(Boolean), JSON.stringify(observed));
  await wait(() => existsSync(join(run, 'evidence/sdk-requests.json')) && /Operation not permitted|Permission denied/.test(readFileSync(join(run, 'evidence/sdk-requests.json'), 'utf8')) && readFileSync(join(run, 'evidence/sdk-requests.json'), 'utf8').includes('outside-status=1'));
  writeFileSync(join(run, 'sdk-finish'), 'done');
  await new Promise<void>(resolve => sdkModel!.once('exit', () => resolve()));
  sdkModel = undefined;
  console.log(`PASS Codex Desktop, Claude Desktop and real HyperNeo SDK outside refusal + inside/Git/temp/cache/network: ${run}/evidence`);


} finally {
  QueryOptionsBuilder.prototype.build = buildOptions;
  sdkModel?.kill();
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}

process.exit(0);
