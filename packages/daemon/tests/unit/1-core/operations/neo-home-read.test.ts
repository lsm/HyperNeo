import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import { homeRemoteUrl } from '../../../../src/lib/neo/home/read.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

let fixture: string;
let root: string;
let db: Awaited<ReturnType<typeof createTestDb>>;
let home: NeoHomeRepository;
let repo: NeoRepository;
const git = async (...args: string[]) => {
  const child = spawnProcess(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
  return text.trim();
};
const read = async (
  path: string,
  caller: OperationCaller = { source: 'rpc', principal: 'local' },
  includeRemote = false
) => {
  const registry = createOperationRegistry(
    createNeoHomeOperations(
      {
        repo,
        todos: new NeoAskTodoRepository(db.getDatabase()),
        defaultSessionId: () => 'neo:root',
      },
      home
    )
  );
  const outcome = await invokeOperation(
    registry,
    'neo.home.read',
    { path, ...(includeRemote ? { includeRemote: true } : {}) },
    caller
  );
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value as {
    ok: boolean;
    reason?: string;
    path?: string;
    content?: string;
    sha256?: string;
    remoteUrl?: string | null;
  };
};
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-read-'));
  root = join(fixture, 'Neo');
  await mkdir(root);
  await git('init', '--quiet');
  await git('config', 'user.name', 'Verify Neo');
  await git('config', 'user.email', 'verify@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  home = new NeoHomeRepository(root, repo);
  await home.init();
});
afterEach(async () => {
  db.close();
  await rm(fixture, { recursive: true, force: true });
});

describe('Neo home read', () => {
  test('reads a local document when inherited Git configuration is malformed', async () => {
    const content = 'Human direction remains readable.\n';
    await writeFile(join(root, 'direction.md'), content);
    const configuration = join(fixture, 'invalid.gitconfig');
    await writeFile(configuration, '[broken\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = configuration;
    try {
      expect(await read('direction.md')).toMatchObject({ ok: true, content });
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
  test.each([
    ['git@github.com:example/neo-home.git', 'https://github.com/example/neo-home'],
    [
      'https://synthetic-user:synthetic-pass@example.invalid/team/neo.git',
      'https://example.invalid/team/neo',
    ],
    ['/tmp/synthetic-remote.git', null],
  ])('projects an origin remote as a browser URL without userinfo: %s', (remote, expected) => {
    expect(homeRemoteUrl(remote)).toBe(expected);
  });
  test('opt-in read of a tracked home adds its remote and leaves HEAD alone', async () => {
    const remote = join(fixture, 'remote.git');
    await git('clone', '--quiet', '--bare', root, remote);
    await git('remote', 'add', 'origin', remote);
    await git('fetch', '--quiet', 'origin');
    await git('branch', '--set-upstream-to', `origin/${await git('branch', '--show-current')}`);
    const head = await git('rev-parse', 'HEAD');
    expect(await read('direction.md', undefined, true)).toMatchObject({
      ok: true,
      remoteUrl: null,
    });
    expect((await read('direction.md')).remoteUrl).toBeUndefined();
    expect(await git('rev-parse', 'HEAD')).toBe(head);
  });
  test('opt-in read shows the configured origin, not a local transport rewrite', async () => {
    const remote = join(fixture, 'remote.git');
    await git('clone', '--quiet', '--bare', root, remote);
    await git('config', `url.${remote}.insteadOf`, 'git@github.com:example/neo-home.git');
    await git('remote', 'add', 'origin', 'git@github.com:example/neo-home.git');
    await git('fetch', '--quiet', 'origin');
    await git('branch', '--set-upstream-to', `origin/${await git('branch', '--show-current')}`);
    expect(await read('direction.md', undefined, true)).toMatchObject({
      ok: true,
      remoteUrl: 'https://github.com/example/neo-home',
    });
  });
  test('opt-in local read reports that no remote is configured', async () => {
    expect((await read('direction.md', undefined, true)).remoteUrl).toBeNull();
  });
  test('returns all local UTF-8 text and its hash, preserving human edits and HEAD', async () => {
    const content = '\ufeff  Human direction 🦊\n' + 'Full text.\n'.repeat(60000) + '\n';
    await writeFile(join(root, 'direction.md'), content);
    const before = await git('rev-parse', 'HEAD');
    const status = await git('status', '--porcelain');
    expect(await read('direction.md')).toEqual({
      ok: true,
      path: 'direction.md',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    expect(await git('status', '--porcelain')).toBe(status);
    expect(await readFile(join(root, 'direction.md'), 'utf8')).toBe(content);
  });
  test('reads a project mandate and empty documents without confirmation', async () => {
    await mkdir(join(root, 'projects', 'verify'), { recursive: true });
    await writeFile(join(root, 'projects', 'verify', 'mandate.md'), 'Curated mandate.');
    expect(await read('projects/verify/mandate.md')).toMatchObject({
      ok: true,
      content: 'Curated mandate.',
    });
    expect(await read('direction.md')).toMatchObject({
      ok: true,
      content: '',
      sha256: createHash('sha256').update('').digest('hex'),
    });
  });
  test.each([
    '../outside.md',
    '/outside.md',
    '.git/config',
    '.coordinators/transcript.md',
    'a/../direction.md',
    'C:\\outside.md',
  ])('refuses an internal or outside path: %s', async (path) => {
    expect(await read(path)).toMatchObject({ ok: false, reason: expect.stringContaining('path') });
  });
  test('refuses ignored documents, directories and symlink destinations', async () => {
    await writeFile(join(root, '.gitignore'), '.coordinators/\nignored.md\n');
    await writeFile(join(root, 'ignored.md'), 'Private synthetic note.');
    expect(await read('ignored.md')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('ignored'),
    });
    await mkdir(join(root, 'folder'));
    expect(await read('folder')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_file'),
    });
    await writeFile(join(fixture, 'outside.md'), 'Outside synthetic note.');
    await symlink(join(fixture, 'outside.md'), join(root, 'linked.md'));
    expect(await read('linked.md')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('path'),
    });
    await symlink(fixture, join(root, 'linked-folder'));
    expect(await read('linked-folder/outside.md')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('path'),
    });
  });
  test('reports missing files or an uninitialized home without creating anything', async () => {
    expect(await read('missing.md')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_found'),
    });
    await rm(root, { recursive: true });
    expect(await read('direction.md')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_found'),
    });
    expect(await readdir(root).catch(() => null)).toBeNull();
  });
  test('refuses non-UTF-8 content without replacing or changing its bytes', async () => {
    const bytes = new Uint8Array([0xff, 0xc3, 0x28]);
    await writeFile(join(root, 'legacy.md'), bytes);
    expect(await read('legacy.md')).toEqual({
      ok: false,
      reason: expect.stringContaining('UTF-8'),
    });
    expect([...(await readFile(join(root, 'legacy.md')))]).toEqual([...bytes]);
  });
  test('requires the local user or root Neo and serializes with saves', async () => {
    expect(
      await read('direction.md', { source: 'mcp', sessionId: 'worker', role: 'neo' })
    ).toMatchObject({ ok: false });
    expect(await read('direction.md', { source: 'rpc' })).toMatchObject({ ok: false });
    const content = '  Saved immediately before read.\n';
    const saved = home.save({ path: 'digest.md', content, message: 'Read fixture' });
    const observed = read('digest.md', { source: 'mcp', sessionId: 'neo:root', role: 'neo' });
    expect(await saved).toMatchObject({ ok: true });
    expect(await observed).toMatchObject({ ok: true, content });
  });
});
