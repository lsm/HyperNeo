import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [run, scenario, expectation] = process.argv.slice(2);
assert(run?.startsWith('/private/tmp/'));
assert(['conflict', 'fast-forward', 'ignored-race', 'untracked-race', 'healthy'].includes(scenario));
assert(['reproduce', 'verify'].includes(expectation));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GIT_CONFIG_GLOBAL, join(run, 'gitconfig'));
await mkdir(join(run, 'evidence'), { recursive: true });
await writeFile(join(run, 'gitconfig'), '[user]\n name = Synthetic Neo\n email = test@example.invalid\n[commit]\n gpgsign = false\n');
async function git(cwd: string, ...args: string[]) {
  const child = spawnProcess(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error); return text.trim();
}
const peer = join(run, 'peer'), remote = join(run, 'shared.git'), root = join(run, 'data', 'Neo');
await mkdir(peer); await git(peer, 'init', '--initial-branch=main', '--quiet');
await writeFile(join(peer, '.gitignore'), '.coordinators/\nignored/\n');
await writeFile(join(peer, 'direction.md'), 'Initial\n');
await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Initial');
await git(run, 'clone', '--bare', peer, remote); await git(peer, 'remote', 'add', 'origin', remote);
const privatePath = scenario === 'untracked-race' ? 'untracked.md' : 'ignored/report.md';
const bytes = Buffer.concat([Buffer.from('Synthetic human result\0'), Buffer.from(Array.from({ length: 8192 }, (_, n) => n % 256))]);
const hash = (value: Buffer | null) => value && createHash('sha256').update(value).digest('hex');
let app: Awaited<ReturnType<typeof import('../../../packages/daemon/src/app.ts').createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { scenario, expectation, root, privatePath, expectedSha256: hash(bytes) };
const release = join(run, 'fetch-release');
try {
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), port: 0, disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport); await transport.initialize();
  const rpc = (name: string, input: unknown) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  assert.equal((await rpc('neo.home.init', { remoteUrl: remote })).ok, true);
  await rpc('neo.open', {});
  if (scenario === 'conflict') {
    await writeFile(join(root, 'direction.md'), 'Human local choice\n');
    await git(root, 'add', 'direction.md'); await git(root, 'commit', '-m', 'Human local choice');
  }
  if (scenario === 'healthy') {
    await mkdir(join(root, 'ignored'), { recursive: true });
    await writeFile(join(root, privatePath), bytes);
  } else {
    await mkdir(join(peer, 'ignored'), { recursive: true });
    await writeFile(join(peer, privatePath), 'Remote colliding content\n');
    await git(peer, 'add', '-f', '--', privatePath);
  }
  await writeFile(join(peer, 'direction.md'), 'Remote direction\n');
  await git(peer, 'add', 'direction.md'); await git(peer, 'commit', '-m', 'Remote update'); await git(peer, 'push', 'origin', 'main');
  const remoteHead = await git(peer, 'rev-parse', 'HEAD');
  const localHead = await git(root, 'rev-parse', 'HEAD');
  const localReflog = await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD');
  const ready = join(run, 'fetch-ready');
  if (scenario.endsWith('-race')) {
    const upload = join(run, 'delayed-upload');
    await writeFile(upload, `#!/bin/sh\n: > '${ready}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\nexec /usr/bin/git-upload-pack "$@"\n`, { mode: 0o755 });
    await git(root, 'config', 'remote.origin.uploadpack', upload);
  } else if (scenario !== 'healthy') {
    await mkdir(join(root, 'ignored'), { recursive: true });
    await writeFile(join(root, privatePath), bytes);
  }
  const pending = rpc('neo.home.read', { path: 'direction.md' });
  if (scenario.endsWith('-race')) {
    for (let n = 0; n < 1000; n++) {
      if (await readFile(ready).then(() => true, () => false)) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    await readFile(ready);
    await mkdir(join(root, 'ignored'), { recursive: true });
    await writeFile(join(root, privatePath), bytes);
    await writeFile(release, 'go');
  }
  evidence.reply = await pending;
  const after = await readFile(join(root, privatePath)).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  evidence.privateAfterConflictRead = after?.toString('base64') ?? null;
  evidence.actualSha256 = hash(after);
  evidence.localHeadBefore = localHead; evidence.localHeadAfter = await git(root, 'rev-parse', 'HEAD');
  evidence.localReflogUnchanged = localReflog === await git(root, 'reflog', 'show', '--format=%H %gs', 'HEAD');
  evidence.remoteHeadUnchanged = remoteHead === await git(remote, 'rev-parse', 'main');
  evidence.localDirection = await readFile(join(root, 'direction.md'), 'utf8');
  if (scenario === 'healthy') {
    assert.equal((evidence.reply as { ok: boolean }).ok, true);
    assert.equal(evidence.localDirection, 'Remote direction\n'); assert.deepEqual(after, bytes);
  } else if (expectation === 'reproduce' && scenario !== 'untracked-race') {
    assert.notEqual(hash(after), hash(bytes));
  } else {
    assert.equal((evidence.reply as { ok: boolean }).ok, false);
    assert.deepEqual(after, bytes); assert.equal(evidence.localHeadAfter, localHead);
    assert.equal(evidence.localReflogUnchanged, true);
  }
  assert.equal(evidence.remoteHeadUnchanged, true);
  console.log(JSON.stringify({ scenario, expectation, reply: evidence.reply, actualSha256: evidence.actualSha256, preserved: hash(after) === hash(bytes) }));
} finally {
  await writeFile(release, 'go');
  await writeFile(join(run, 'evidence/neo-home-sync-preserve.json'), JSON.stringify(evidence, null, 2));
  await transport?.close(); await app?.cleanup();
}
