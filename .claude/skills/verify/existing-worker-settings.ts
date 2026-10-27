import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
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
mkdirSync(join(remote, '.claude'));
writeFileSync(join(remote, '.claude/settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}');
git(remote, 'add', '.');
git(remote, 'commit', '-m', 'initial');
git(run, 'clone', remote, source);
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
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: name.startsWith('rpc:') ? name.slice(4) : 'operation.invoke', data: name.startsWith('rpc:') ? input : { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  await rpc('rpc:settings.global.update', { updates: { workerSandbox: 'always' } });
  const registry = await rpc('rpc:mcp.registry.list', {}) as { servers: { id: string }[] };
  for (const server of registry.servers) await rpc('rpc:mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-synthetic-loopback-only' } });
  const started = await rpc('work.start', {
    adapter: 'hyperneo', place: { machine: hostname(), folder: source, name: 'Synthetic source' },
    title: 'Prepared project session', message: 'Synthetic placement only',
    preparation: { pack: 'coding', parameters: { target: 'dev' } },
  }) as Result<WorkStarted>;
  assert(started.ok, JSON.stringify(started));
  const session = app.db.getSession(started.value.ref.id);
  assert(session?.workspacePath, 'started session must carry its prepared workspace');
  const worker = session.workspacePath!;
  const settings = join(worker, '.claude/settings.local.json');
  const policy = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(policy.sandbox.enabled, true);
  assert.deepEqual(policy.permissions.allow, [`Edit(/${worker}/**)`]);
  assert(policy.permissions.deny.includes(`Edit(/${source}/**)`));
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await rpc('work.start', {
      adapter: 'hyperneo', place: { machine: hostname(), folder: worker, name: 'Existing worktree' },
      title: 'Repeat start', message: 'Synthetic placement only', inPlace: true,
    }) as Result<WorkStarted>;
    assert(next.ok, JSON.stringify(next));
    assert.equal(app.db.getSession(next.value.ref.id)!.workspacePath, worker);
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).sandbox, policy.sandbox);
    evidence.push({ attempt, sameWorktree: true, started: next });
  }
  evidence.push({ preExistingSettingsReplaced: true, repeatedStarts: 2, policy });
  console.log('PASS work.start replaced existing settings and started twice more in the same worktree');
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
