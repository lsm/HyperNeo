import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations.ts';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { spawnProcess } from '../../../../src/lib/runtime-spawn/index.ts';
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
const save = async (
  input: { path: string; content: string; message?: string },
  caller: OperationCaller = { source: 'rpc', principal: 'local' }
) => {
  const registry = createOperationRegistry(
    createNeoHomeOperations({ repo, defaultSessionId: () => 'neo:root' }, home)
  );
  const result = await invokeOperation(
    registry,
    'neo.home.save',
    { message: 'Update digest', ...input },
    caller
  );
  if (result.kind !== 'completed') throw new Error(result.message);
  return result.value as { ok: boolean; reason?: string; path?: string; commit?: string };
};
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'neo-home-save-'));
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

describe('Neo home save', () => {
  test('commits one curated file without changing its bytes, and unchanged retry adds no commit', async () => {
    const input = {
      path: 'projects/verify/digest.md',
      content: '  Progress\n\n',
      message: 'Record progress',
    };
    const first = await save(input);
    expect(first).toMatchObject({
      ok: true,
      path: input.path,
      commit: await git('rev-parse', 'HEAD'),
    });
    expect(await readFile(join(root, input.path), 'utf8')).toBe(input.content);
    expect(await git('show', '--format=', '--name-only', 'HEAD')).toBe(input.path);
    expect(await git('log', '-1', '--format=%s')).toBe('Record progress');
    expect(await save(input)).toEqual(first);
    expect(await git('rev-list', '--count', 'HEAD')).toBe('2');
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each([
    '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----',
    'sk-' + 'a'.repeat(32),
    'ghp_' + 'b'.repeat(36),
    'github_pat_' + 'c'.repeat(32),
    'xoxb-' + 'd'.repeat(24),
    'AKIA' + 'E'.repeat(16),
    'API_KEY="' + 'f'.repeat(24) + '"',
    'TOKEN=' + 'g'.repeat(24),
    'SECRET=' + 'h'.repeat(24),
    'PASSWORD=' + 'i'.repeat(24),
  ])('refuses synthetic credential content without writes: %s', async (content) => {
    const before = await git('rev-parse', 'HEAD');
    expect(await save({ path: 'digest.md', content })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('content'),
    });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each([
    '../escape.md',
    '/outside.md',
    '.git/config',
    '.coordinators/transcript.md',
    'a/../direction.md',
  ])('refuses internal or outside paths: %s', async (path) => {
    expect(await save({ path, content: 'Curated.' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('path'),
    });
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each(['direction.md', 'projects/verify/mandate.md'])(
    'keeps %s confirmation-gated until H2',
    async (path) => {
      expect(await save({ path, content: 'New direction.' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_required'),
      });
    }
  );
  test.each(['untracked', 'staged', 'modified'])(
    'refuses %s human changes without altering them',
    async (state) => {
      if (state === 'modified') await writeFile(join(root, 'README.md'), 'Human change.');
      else await writeFile(join(root, 'human.md'), 'Human draft.');
      if (state === 'staged') await git('add', 'human.md');
      const before = await git('status', '--porcelain', '-z');
      expect(await save({ path: 'digest.md', content: 'Curated.' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('dirty'),
      });
      expect(await git('status', '--porcelain', '-z')).toBe(before);
    }
  );
  test('refuses an ignored document and a symlink into another folder', async () => {
    await writeFile(join(root, '.gitignore'), '.coordinators/\nignored.md\n');
    await git('commit', '-am', 'Ignore a document');
    expect(await save({ path: 'ignored.md', content: 'Curated.' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('ignored'),
    });
    await mkdir(join(fixture, 'outside'));
    await symlink(join(fixture, 'outside'), join(root, 'linked'));
    await git('add', 'linked');
    await git('commit', '-m', 'Synthetic link');
    expect(await save({ path: 'linked/digest.md', content: 'Curated.' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('path'),
    });
    expect(
      await readFile(join(fixture, 'outside', 'digest.md'), 'utf8').catch(() => null)
    ).toBeNull();
  });
  test('refuses a first save on a dirty non-repository without bootstrapping it', async () => {
    await rm(root, { recursive: true });
    await mkdir(root);
    await writeFile(join(root, 'human.md'), 'Preserve me.');
    expect(await save({ path: 'digest.md', content: 'Curated.' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('dirty'),
    });
    expect(await readFile(join(root, 'README.md'), 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(root, '.git', 'HEAD'), 'utf8').catch(() => null)).toBeNull();
  });
  test.each(['existing', 'new'])(
    'restores only its own %s document after commit failure',
    async (state) => {
      if (state === 'existing') {
        await save({ path: 'digest.md', content: 'Original bytes.\n' });
      }
      const before = await git('rev-parse', 'HEAD');
      await git('config', 'user.name', '');
      await git('config', 'user.email', '');
      await expect(save({ path: 'digest.md', content: 'Changed.' })).rejects.toThrow(
        'Author identity unknown'
      );
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      expect(await git('status', '--porcelain')).toBe('');
      expect(await readFile(join(root, 'digest.md'), 'utf8').catch(() => null)).toBe(
        state === 'existing' ? 'Original bytes.\n' : null
      );
    }
  );
  test('preserves the original error when file creation itself fails', async () => {
    await expect(save({ path: 'x'.repeat(300), content: 'Curated.' })).rejects.toThrow(
      'ENAMETOOLONG'
    );
    expect(await git('status', '--porcelain')).toBe('');
  });
  test('serializes concurrent saves and only admits the local user or root Neo', async () => {
    expect(
      await save(
        { path: 'digest.md', content: 'No.' },
        { source: 'mcp', sessionId: 'worker', role: 'neo' }
      )
    ).toMatchObject({ ok: false });
    const results = await Promise.all([
      save(
        { path: 'one.md', content: 'One.' },
        { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
      ),
      save({ path: 'two.md', content: 'Two.' }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await git('rev-list', '--count', 'HEAD')).toBe('3');
    expect(await git('status', '--porcelain')).toBe('');
  });
});
