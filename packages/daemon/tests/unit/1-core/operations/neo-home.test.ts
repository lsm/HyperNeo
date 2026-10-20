import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  test('reading an uninitialized home does not bootstrap files or commits', async () => {
    expect(await call('neo.home.read', { path: 'README.md' })).toMatchObject({ ok: false });
    expect(await git('ls-files')).toBe('');
    await expect(readFile(join(root, 'README.md'), 'utf8')).rejects.toThrow();
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
  ])('refuses secret-like content %s', async (content) => {
    expect(await save('digest.md', content)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('secret_content'),
    });
  });
  test.each(['direction.md', 'projects/release/mandate.md'])(
    'keeps %s gated until H2',
    async (path) => {
      expect(await save(path)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('confirmation_required'),
      });
    }
  );
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
