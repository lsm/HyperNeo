import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const save = async (
  input: { path: string; content: string; message?: string },
  caller: OperationCaller = { source: 'rpc', principal: 'local' }
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
  test('Neo saves and commits with an untracked evidence folder in its home', async () => {
    await mkdir(join(root, 'evidence'));
    await writeFile(join(root, 'evidence', 'run.json'), '{"observed":true}');
    const result = await save(
      { path: 'runbook.md', content: 'Neo owns this document.' },
      { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
    );
    expect(result).toMatchObject({ ok: true, commit: await git('rev-parse', 'HEAD') });
    expect(await git('show', 'HEAD:runbook.md')).toBe('Neo owns this document.');
    expect(await git('ls-files', 'evidence')).toBe('');
    expect(await readFile(join(root, 'evidence', 'run.json'), 'utf8')).toBe('{"observed":true}');
  });
  test.each(['first save', 'legacy ignore'])('preserves runtime folders on %s', async (state) => {
    const prior = process.env.GIT_CONFIG_GLOBAL;
    try {
      if (state === 'first save') {
        await rm(root, { recursive: true });
        await mkdir(root);
        const config = join(fixture, 'gitconfig');
        await writeFile(
          config,
          '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n'
        );
        process.env.GIT_CONFIG_GLOBAL = config;
      } else {
        await writeFile(join(root, '.gitignore'), '.coordinators/\n');
        await git('commit', '-am', 'Legacy runtime ignore');
      }
      for (const dir of ['.coordinators', '.claude', 'worktrees']) {
        await mkdir(join(root, dir, 'verify'), { recursive: true });
        await writeFile(join(root, dir, 'verify', 'private.md'), `Synthetic ${dir} bytes.`);
      }
      expect(await save({ path: 'digest.md', content: 'Curated.' })).toMatchObject({ ok: true });
      expect(await readFile(join(root, 'digest.md'), 'utf8')).toBe('Curated.');
      for (const dir of ['.coordinators', '.claude', 'worktrees']) {
        expect(await readFile(join(root, dir, 'verify', 'private.md'), 'utf8')).toBe(
          `Synthetic ${dir} bytes.`
        );
        expect(await git('ls-files', '--', dir)).toBe('');
        expect(await git('show', 'HEAD:.gitignore')).toContain(`${dir}/`);
      }
      expect(await git('status', '--porcelain')).toBe('');
    } finally {
      if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prior;
    }
  });
  test('commits one curated file without changing its bytes, and unchanged retry adds no commit', async () => {
    const input = {
      path: 'projects/verify/digest.md',
      content: '  Progress 🦊\n\n',
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
  test.each(['\ud800', '\udc00'])(
    'refuses malformed Unicode without changing HEAD',
    async (content) => {
      const before = await git('rev-parse', 'HEAD');
      expect(await save({ path: 'surrogate.md', content })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('Unicode'),
      });
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      expect(await git('status', '--porcelain')).toBe('');
    }
  );
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
    'keeps %s gated without a human confirmation',
    async (path) => {
      expect(await save({ path, content: 'New direction.' })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_required'),
      });
    }
  );
  test('repairs a missing coordinator ignore before saving, preserving transcripts', async () => {
    await rm(join(root, '.gitignore'));
    await git('commit', '-am', 'Existing home without coordinator ignore');
    await mkdir(join(root, '.coordinators', 'verify'), { recursive: true });
    await writeFile(join(root, '.coordinators', 'verify', 'transcript.md'), 'Private fixture.');
    expect(await save({ path: 'digest.md', content: 'Curated.' })).toMatchObject({ ok: true });
    expect(await readFile(join(root, '.coordinators', 'verify', 'transcript.md'), 'utf8')).toBe(
      'Private fixture.'
    );
    expect(await git('ls-files', '.coordinators')).toBe('');
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each(['untracked', 'staged', 'modified', 'staged transcript'])(
    'refuses %s human changes without altering them',
    async (state) => {
      if (state === 'modified') await writeFile(join(root, 'README.md'), 'Human change.');
      else if (state !== 'staged transcript')
        await writeFile(join(root, 'human.md'), 'Human draft.');
      if (state === 'staged') await git('add', 'human.md');
      if (state === 'staged transcript') {
        await rm(join(root, '.gitignore'));
        await git('commit', '-am', 'Existing home without coordinator ignore');
        await mkdir(join(root, '.coordinators'), { recursive: true });
        await writeFile(join(root, '.coordinators', 'transcript.md'), 'Private fixture.');
        await git('add', '.coordinators/transcript.md');
      }
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
  test.each(['existing', 'new', 'non-UTF-8'])(
    'restores only its own %s document after commit failure',
    async (state) => {
      if (state === 'existing') {
        await save({ path: 'digest.md', content: 'Original bytes.\n' });
      }
      if (state === 'non-UTF-8') {
        await writeFile(join(root, 'digest.md'), new Uint8Array([0xff, 0xc3, 0x28]));
        await git('add', 'digest.md');
        await git('commit', '-m', 'Synthetic legacy bytes');
      }
      const original = await readFile(join(root, 'digest.md')).catch(() => null);
      const before = await git('rev-parse', 'HEAD');
      await git('config', 'user.name', '');
      await git('config', 'user.email', '');
      await expect(save({ path: 'digest.md', content: 'Changed.' })).rejects.toThrow(
        'Author identity unknown'
      );
      expect(await git('rev-parse', 'HEAD')).toBe(before);
      expect(await git('status', '--porcelain')).toBe('');
      expect(await readFile(join(root, 'digest.md')).catch(() => null)).toEqual(original);
    }
  );
  test('reports an invalid filesystem name without changing the repository', async () => {
    await expect(save({ path: 'x'.repeat(300), content: 'Curated.' })).rejects.toThrow(
      'ENAMETOOLONG'
    );
    expect(await git('status', '--porcelain')).toBe('');
  });
  test('preserves the actual write error when no file was created', async () => {
    const parent = join(root, 'readonly');
    await mkdir(parent);
    await chmod(parent, 0o555);
    try {
      await expect(save({ path: 'readonly/digest.md', content: 'Curated.' })).rejects.toThrow(
        'EACCES'
      );
      expect(await readFile(join(parent, 'digest.md'), 'utf8').catch(() => null)).toBeNull();
      expect(await git('status', '--porcelain')).toBe('');
    } finally {
      await chmod(parent, 0o755);
    }
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
