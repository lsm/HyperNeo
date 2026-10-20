import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { neoToolGuard } from '../../../../src/lib/neo/look-up-guard';
import { createNeoHomeOperations } from '../../../../src/lib/neo/home/operations';
import { NeoHomeRepository } from '../../../../src/lib/neo/home/repository';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { spawnProcess } from '../../../../src/lib/runtime-spawn';
import { createTestDb } from '../../../helpers/database';

let db: Awaited<ReturnType<typeof createTestDb>>;
let root: string;
let repo: NeoRepository;
let home: NeoHomeRepository;
const git = async (...args: string[]) => {
  const child = spawnProcess(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(error);
  return out.trim();
};
const call = async (
  name: string,
  input: unknown,
  caller = { source: 'rpc', principal: 'local' }
) => {
  const registry = createOperationRegistry(
    createNeoHomeOperations({ repo, defaultSessionId: () => 'neo:root' }, home)
  );
  const result = await invokeOperation(
    registry,
    name,
    input,
    caller as Parameters<typeof invokeOperation>[3]
  );
  if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
  return result.value as {
    ok: boolean;
    reason?: string;
    path?: string;
    commit?: string;
    content?: string;
  };
};
beforeEach(async () => {
  db = await createTestDb();
  root = await mkdtemp(join(tmpdir(), 'neo-home-'));
  repo = new NeoRepository(db.getDatabase());
  home = new NeoHomeRepository(root, repo);
  await git('init', '--quiet');
  await git('config', 'user.name', 'Verify Neo');
  await git('config', 'user.email', 'verify@example.invalid');
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
const save = (path: string, content = 'Release is ready.\n') =>
  call('neo.home.save', { path, content, message: 'Record release progress' });

describe('Neo home operations', () => {
  test('initializes once, ignores coordinator transcripts, and saves a readable local commit', async () => {
    await mkdir(join(root, '.coordinators', 'root'), { recursive: true });
    await writeFile(join(root, '.coordinators', 'root', 'transcript.md'), 'Private conversation');
    expect(await call('neo.home.init', {})).toMatchObject({ ok: true, path: root });
    const first = await git('rev-parse', 'HEAD');
    expect(await call('neo.home.init', {})).toMatchObject({ ok: true });
    expect(await git('rev-parse', 'HEAD')).toBe(first);
    expect(await git('ls-files')).toBe('.gitignore\nREADME.md\ndirection.md');
    expect(await save('projects/release/digest.md')).toMatchObject({
      ok: true,
      commit: expect.any(String),
    });
    expect(await call('neo.home.read', { path: 'projects/release/digest.md' })).toMatchObject({
      ok: true,
      content: 'Release is ready.\n',
    });
    expect(await git('show', 'HEAD:projects/release/digest.md')).toBe('Release is ready.');
    expect(await git('status', '--porcelain')).toBe('');
  });
  test.each([false, true])(
    'a refused first save leaves an untracked home unchanged (git metadata: %s)',
    async (metadata) => {
      if (!metadata) await rm(join(root, '.git'), { recursive: true });
      await writeFile(join(root, 'notes.txt'), 'Human notes.');
      const before = (await readdir(root)).sort();
      expect(await save('digest.md')).toMatchObject({
        ok: false,
        reason: expect.stringContaining('dirty'),
      });
      expect((await readdir(root)).sort()).toEqual(before);
      expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('Human notes.');
    }
  );
  test('reading an uninitialized home does not bootstrap files or commits', async () => {
    expect(await call('neo.home.read', { path: 'README.md' })).toMatchObject({ ok: false });
    expect(await git('ls-files')).toBe('');
    await expect(readFile(join(root, 'README.md'), 'utf8')).rejects.toThrow();
  });
  test.each([
    ['direction.md', 'Human company direction.', 'confirmation_required'],
    ['README.md', 'API_TOKEN=abcdefghijklmnop', 'secret_content'],
  ])(
    'refused bootstrap preserves existing %s without creating files',
    async (path, content, reason) => {
      await rm(join(root, '.git'), { recursive: true });
      await writeFile(join(root, path), content);
      await writeFile(join(root, '.gitignore'), 'human-private/\n');
      for (const name of ['neo.home.init', 'neo.home.init', 'neo.home.save']) {
        expect(
          await call(
            name,
            name === 'neo.home.save'
              ? { path: 'digest.md', content: 'Ready.', message: 'Save digest' }
              : {}
          )
        ).toMatchObject({
          ok: false,
          reason: expect.stringContaining(reason),
        });
        expect((await readdir(root)).sort()).toEqual(['.gitignore', path].sort());
        expect(await readFile(join(root, path), 'utf8')).toBe(content);
        expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('human-private/\n');
      }
    }
  );
  test('uses literal document names when checking git ignores', async () => {
    await call('neo.home.init', {});
    await writeFile(
      join(root, '.gitignore'),
      '.coordinators/\nprivate-*.md\nprivate[[]draft].md\n'
    );
    await git('add', '.gitignore');
    await git('commit', '-m', 'Ignore literal private document names');
    for (const path of ['private-*.md', 'private[draft].md']) {
      await writeFile(join(root, path), 'Private draft.');
      expect(await call('neo.home.read', { path })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('ignored'),
      });
      expect(await save(path)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('ignored'),
      });
    }
    expect(await save('release[draft].md')).toMatchObject({ ok: true });
    expect(await call('neo.home.read', { path: 'release[draft].md' })).toMatchObject({
      ok: true,
      content: 'Release is ready.\n',
    });
  });
  test('an initialized project keeps the same home path after rename and restart', async () => {
    repo.saveProject({ id: 'project-release', title: 'Release', summary: '', context: '' }, 0);
    await call('neo.home.init', {});
    const first = repo.getProject('project-release')!;
    expect(first.homePath).toMatch(/^projects\/release-/);
    repo.saveProject({ id: first.id, title: 'Renamed', summary: '', context: '' }, first.revision);
    await new NeoHomeRepository(root, new NeoRepository(db.getDatabase())).init();
    expect(repo.getProject(first.id)?.homePath).toBe(first.homePath);
  });
  test.each([
    '../outside.md',
    '.git/config',
    '.coordinators/root/transcript.md',
    '/tmp/outside.md',
  ])('refuses private or escaping path %s', async (path) => {
    expect(await save(path)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('invalid_path'),
    });
    expect(await call('neo.home.read', { path })).toMatchObject({ ok: false });
  });
  test('refuses symlink parents and git-ignored documents', async () => {
    await call('neo.home.init', {});
    const outside = await mkdtemp(join(tmpdir(), 'neo-outside-'));
    try {
      await symlink(outside, join(root, 'linked'));
      expect(await save('linked/digest.md')).toMatchObject({
        ok: false,
        reason: expect.stringContaining('invalid_path'),
      });
      await rm(join(root, 'linked'));
      await writeFile(join(root, '.gitignore'), '.coordinators/\nprivate.md\n');
      await git('add', '.gitignore');
      await git('commit', '-m', 'Ignore private docs');
      expect(await save('private.md')).toMatchObject({
        ok: false,
        reason: expect.stringContaining('ignored'),
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  test('refuses dirty files without overwriting human edits or committing staged changes', async () => {
    await save('digest.md');
    const first = await git('rev-parse', 'HEAD');
    await writeFile(join(root, 'digest.md'), 'Human edits');
    expect(await save('digest.md', 'Overwrite')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('dirty'),
    });
    expect(await readFile(join(root, 'digest.md'), 'utf8')).toBe('Human edits');
    await git('add', 'digest.md');
    expect(await save('other.md')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('dirty'),
    });
    expect(await git('rev-parse', 'HEAD')).toBe(first);
  });
  test.each([
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'sk-test-value',
    'ghp_fakevalue',
    'github_pat_fakevalue',
    'xoxb-fakevalue',
    'AKIAFAKEVALUE',
    'API_TOKEN=abcdefghijklmnop',
    'PASSWORD="a long fake password value"',
  ])('refuses secret-like content %s', async (content) => {
    expect(await save('digest.md', content)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('secret_content'),
    });
  });
  test.each([
    'direction.md',
    'Direction.md',
    'DIRECTION.MD',
    'projects/release/mandate.md',
    'projects/release/MANDATE.md',
  ])('keeps %s gated until H2', async (path) => {
    expect(await save(path)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('confirmation_required'),
    });
  });
  test.each(['projects', 'digest.md/child.md'])(
    'refuses non-document path %s through both operation doors',
    async (path) => {
      await save('digest.md');
      await mkdir(join(root, 'projects'), { recursive: true });
      const head = await git('rev-parse', 'HEAD');
      expect(await call('neo.home.read', { path })).toMatchObject({
        ok: false,
        reason: expect.stringContaining('invalid_path'),
      });
      expect(await save(path)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('invalid_path'),
      });
      expect(await git('rev-parse', 'HEAD')).toBe(head);
      expect(await readFile(join(root, 'digest.md'), 'utf8')).toBe('Release is ready.\n');
    }
  );
  test('native reads and searches keep ignored documents private while allowing curated docs', async () => {
    const dataDir = root;
    root = join(dataDir, 'Neo');
    await mkdir(root);
    home = new NeoHomeRepository(root, repo);
    await git('init', '--quiet');
    await git('config', 'user.name', 'Verify Neo');
    await git('config', 'user.email', 'verify@example.invalid');
    await call('neo.home.init', {});
    await writeFile(join(root, '.gitignore'), '.coordinators/\nhuman-private/\n');
    await mkdir(join(root, 'human-private'));
    await writeFile(join(root, 'human-private', 'draft.md'), 'Private draft.');
    await mkdir(join(root, 'projects'));
    await writeFile(join(root, 'projects', 'public.md'), 'Curated document.');
    const cwd = join(root, '.coordinators', 'test');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'own.md'), 'Own working note.');
    const guard = neoToolGuard({ home: dataDir, dataDir, own: [cwd] });
    const hook = (tool_name: string, tool_input: Record<string, unknown>) =>
      guard(
        {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input,
          cwd,
          session_id: 'test',
          tool_use_id: 'test',
          transcript_path: join(cwd, 'transcript'),
        } as HookInput,
        'test',
        { signal: new AbortController().signal }
      );
    try {
      for (const [tool, input] of [
        ['Read', { file_path: join(root, 'human-private', 'draft.md') }],
        [
          'Grep',
          { path: root, pattern: '.', glob: '**/draft.md', output_mode: 'files_with_matches' },
        ],
        ['Glob', { path: root, pattern: '**/draft.md' }],
        ['Grep', { path: join(root, 'human-private'), pattern: '.', output_mode: 'count' }],
      ] as const)
        expect(await hook(tool, input)).toMatchObject({
          hookSpecificOutput: { permissionDecision: 'deny' },
        });
      for (const [tool, input] of [
        ['Read', { file_path: join(root, 'README.md') }],
        ['Read', { file_path: join(cwd, 'own.md') }],
        [
          'Grep',
          {
            path: join(root, 'projects'),
            pattern: '.',
            glob: '*.md',
            output_mode: 'files_with_matches',
          },
        ],
        ['Glob', { path: root, pattern: 'projects/**/*.md' }],
      ] as const)
        expect(await hook(tool, input)).toEqual({});
    } finally {
      root = dataDir;
    }
  });
  test('native home reads stay closed after initialization is refused', async () => {
    const dataDir = root;
    root = join(dataDir, 'Neo');
    await mkdir(root);
    home = new NeoHomeRepository(root, repo);
    const cwd = join(root, '.coordinators', 'test');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, 'human-private'));
    await writeFile(join(root, 'direction.md'), 'Human direction.');
    await writeFile(join(root, '.gitignore'), 'human-private/\n');
    await writeFile(join(root, 'human-private', 'draft.md'), 'Private draft.');
    await writeFile(join(cwd, 'own.md'), 'Own working note.');
    const guard = neoToolGuard({ home: dataDir, dataDir, own: [cwd] });
    const hook = (tool_name: string, tool_input: Record<string, unknown>) =>
      guard(
        {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input,
          cwd,
          session_id: 'test',
          tool_use_id: 'test',
          transcript_path: join(cwd, 'transcript'),
        } as HookInput,
        'test',
        { signal: new AbortController().signal }
      );
    try {
      expect(await call('neo.home.init', {})).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_required'),
      });
      await expect(readFile(join(root, '.git', 'HEAD'), 'utf8')).rejects.toThrow();
      for (const [tool, input] of [
        ['Read', { file_path: join(root, 'human-private', 'draft.md') }],
        ['Read', { file_path: join(root, 'direction.md') }],
        [
          'Grep',
          { path: join(root, 'human-private'), pattern: '.', output_mode: 'files_with_matches' },
        ],
        ['Glob', { path: root, pattern: '**/draft.md' }],
      ] as const)
        expect(await hook(tool, input)).toMatchObject({
          hookSpecificOutput: { permissionDecision: 'deny' },
        });
      expect(await hook('Read', { file_path: join(cwd, 'own.md') })).toEqual({});
    } finally {
      root = dataDir;
    }
  });
  test('only root Neo and the local human can use the home operations', async () => {
    for (const source of ['mcp', 'internal']) {
      expect(await call('neo.home.init', {}, { source, principal: 'worker' })).toMatchObject({
        ok: false,
      });
    }
    expect(
      await call('neo.home.init', {}, { source: 'mcp', sessionId: 'neo:root' } as never)
    ).toMatchObject({ ok: true });
  });
});
