import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { workerWorkLocations } from '../../../packages/daemon/src/lib/work-locations.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};

const repo = join(run, 'repo');
const git = (...args: string[]) => {
  const result = spawnSync(
    'git',
    ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args],
    { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
mkdirSync(repo);
git('init', '-b', 'dev');
git('commit', '--allow-empty', '-m', 'synthetic');

const places = ['builds', 'scratch', 'ghConfig', 'evidence'] as const;
function plantFolders(root: string) {
  const locations = workerWorkLocations(root);
  for (const place of places) {
    mkdirSync(locations[place], { recursive: true });
    writeFileSync(join(locations[place], 'synthetic'), place);
  }
  return locations;
}
const present = (root: string) =>
  Object.fromEntries(places.map((place) => [place, existsSync(join(workerWorkLocations(root)[place], 'synthetic'))]));

const config = () => getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
async function rpc(method: string, data: unknown) {
  ws = createLocalSocket(`ws://127.0.0.1:${app!.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('connection failed'));
  });
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 30000);
    ws!.onmessage = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id && response.requestId !== id) return;
      clearTimeout(timer);
      done(response);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  ws.close();
  ws = undefined;
  return reply;
}

async function worktreeSession(name: string) {
  const worktreePath = join(run, 'worktrees', name);
  const branch = `session/${name}`;
  git('worktree', 'add', '-b', branch, worktreePath, 'dev');
  plantFolders(worktreePath);
  const now = new Date().toISOString();
  await app!.db.createSession({
    id: name,
    title: name,
    workspacePath: worktreePath,
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
    worktree: { isWorktree: true, worktreePath, mainRepoPath: repo, branch },
  });
  return worktreePath;
}

try {
  app = await createDaemonApp({ config: config(), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);

  const sibling = join(run, 'worktrees', 'sibling');
  plantFolders(sibling);
  const archived = await worktreeSession('archived');
  const archive = await rpc('session.archive', { sessionId: 'archived', confirmed: true });
  assert(!archive.error, JSON.stringify(archive));
  evidence.archive = { treeRemoved: !existsSync(archived), folders: present(archived), sibling: present(sibling) };
  assert.deepEqual(present(archived), { builds: false, scratch: false, ghConfig: false, evidence: true });
  assert.deepEqual(present(sibling), { builds: true, scratch: true, ghConfig: true, evidence: true });

  const deleted = await worktreeSession('deleted');
  const removal = await rpc('session.delete', { sessionId: 'deleted', confirmed: true });
  assert(!removal.error, JSON.stringify(removal));
  evidence.delete = { treeRemoved: !existsSync(deleted), folders: present(deleted) };
  assert.deepEqual(present(deleted), { builds: false, scratch: false, ghConfig: false, evidence: true });

  const inPlace = join(run, 'in-place');
  mkdirSync(inPlace);
  plantFolders(inPlace);
  const now = new Date().toISOString();
  await app.db.createSession({
    id: 'in-place',
    title: 'in-place',
    workspacePath: inPlace,
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  const kept = await rpc('session.archive', { sessionId: 'in-place', confirmed: true });
  assert(!kept.error, JSON.stringify(kept));
  evidence.inPlace = { folderKept: existsSync(inPlace), folders: present(inPlace) };
  assert.deepEqual(present(inPlace), { builds: true, scratch: false, ghConfig: true, evidence: true });

  const blocked = await worktreeSession('blocked');
  const blockedBuilds = workerWorkLocations(blocked).builds;
  const originalSpawn = Bun.spawn;
  Bun.spawn = ((args, options) => {
    if (Array.isArray(args) && args.includes('worker-runtime-cleanup') && args.includes(blockedBuilds)) {
      args = [...args];
      args[args.indexOf('/bin/sh') + 2] = "printf 'synthetic cleanup boundary unavailable' >&2; exit 23";
    }
    return originalSpawn(args, options);
  }) as typeof Bun.spawn;
  let failed: Record<string, unknown>;
  try {
    failed = await rpc('session.archive', { sessionId: 'blocked', confirmed: true });
  } finally {
    Bun.spawn = originalSpawn;
  }
  const row = app.db.getSession('blocked');
  evidence.failure = { rpcError: failed.error ?? null, status: row?.status, folders: present(blocked) };
  assert(!failed.error, JSON.stringify(failed));
  assert.equal(row?.status, 'archived');
  assert.deepEqual(present(blocked), { builds: true, scratch: false, ghConfig: false, evidence: true });

  const health = await rpc('system.health', {});
  assert(!health.error, JSON.stringify(health));
  evidence.health = (health.data as { status?: string }).status;
  assert(existsSync(join(run, 'data/daemon.db')));
  assert.equal(readFileSync(join(workerWorkLocations(sibling).ghConfig, 'synthetic'), 'utf8'), 'ghConfig');
  evidence.passed = true;
  console.log('PASS archive and delete remove a removed tree\'s work folders; in-place, sibling and evidence folders stay; failure is nonfatal');
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/worker-work-folders.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
